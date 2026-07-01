// Оркестрация генерации статьи по ПРОМТУ: текст промта → Claude → запись в БД.
// У промта есть свой авторский блок ссылок (BBCode) и теги. Блок вставляется по {{LINKS}},
// в его URL добавляются Binom-параметры (s1=статья, s2=порядковый номер ссылки).
// prepareGeneration/persistArticle переиспользуют и реалтайм (этот файл), и батч (lib/batch.js).

import { pickKey, markKeyUsed } from './keys.js';
import { generateArticle } from './claude.js';
import { offerPhrasesFromBlock } from './linkblock.js';
import { logArticleEvent } from './events.js';

const LINK_MARKER = '{{LINKS}}';
const KEYWORD_MARKER = '{{KEYWORD}}'; // место в промте, куда подставляется целевой ключ при генерации по списку
const OFFERS_MARKER = '{{OFFERS}}'; // место в промте → подставляются ТЕКСТОВЫЕ бонус-фразы из link_block (без URL)
const STOPWORD_MAX_REGEN = Number(process.env.STOPWORD_MAX_REGEN || 3); // сколько раз перегенерить при стоп-словах

// Стоп-слова промта: строки/через запятую → массив (уникальный, без пустых).
export function parseStopWords(s) {
  return [...new Set(String(s || '').split(/[,;\n\r]+/).map((w) => w.trim()).filter(Boolean))];
}
const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripHtml = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');

// Найти стоп-слова в тексте (регистронезависимо, по границам букв/цифр — чтобы «ass» не ловилось в «Kasse»).
export function findStopWords(text, words) {
  const hay = String(text || '');
  const hits = [];
  for (const w of words) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeReg(w)}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(hay)) hits.push(w);
  }
  return hits;
}

function makeTrackingId(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site';
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${slug}-${ymd}-${Math.random().toString(36).slice(2, 8)}`;
}

// Подготовка к генерации: загрузка сайта/промта/ключа, дневной лимит, сборка finalPrompt.
// extra — сколько статей собираемся добавить (реалтайм=1, батч=count) — учитывается в лимите.
// Возвращает { site, prompt, key, finalPrompt, tags, linkBlock, warnings }.
export function prepareGeneration(db, { siteId, promptId, extra = 1, keyword = null, backend = 'api' } = {}) {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site) throw new Error(`Сайт ${siteId} не найден.`);
  const prompt = promptId
    ? db.prepare('SELECT * FROM prompts WHERE id = ? AND site_id = ?').get(promptId, siteId)
    : db.prepare('SELECT * FROM prompts WHERE site_id = ? AND active = 1 ORDER BY id LIMIT 1').get(siteId);
  if (!prompt) throw new Error('Промт не найден (выбери промт или сделай один активным).');
  if (!prompt.content || !prompt.content.trim()) throw new Error('У промта пустой текст.');
  // backend 'cli' (подписка) не требует API-ключа Claude — ключ нужен только для API-пути.
  const key = backend === 'cli' ? null : pickKey();
  if (backend !== 'cli' && !key) throw new Error('Нет включённых ключей Claude.');

  // Дневной лимит генерации (защита от случайного цикла / перерасхода). 0 = без лимита.
  if (site.daily_limit && site.daily_limit > 0) {
    const today = db.prepare("SELECT COUNT(*) c FROM articles WHERE site_id = ? AND date(generated_at) = date('now')").get(siteId).c;
    if (today + extra > site.daily_limit) {
      throw new Error(`Дневной лимит генерации: уже ${today}, лимит ${site.daily_limit} (запрошено ещё ${extra}).`);
    }
  }

  const tags = String(prompt.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  // Блок ссылок — отдельная сущность (link_blocks), промт ссылается на неё (link_block_id). Берём ВКЛючённый блок;
  // при генерации НЕ вшиваем — подставим при публикации (актуальный на тот момент). linkBlock тут — для {{OFFERS}}.
  const block = prompt.link_block_id ? db.prepare('SELECT * FROM link_blocks WHERE id = ? AND enabled = 1').get(prompt.link_block_id) : null;
  const linkBlock = block?.block || '';
  const linkBlockId = block?.id || null;
  const stopWords = parseStopWords(prompt.stop_words);
  const warnings = [];
  if (linkBlock && tags.length < 2) warnings.push('у промта меньше 2 тегов (для публикации нужно ≥2).');

  let finalPrompt = prompt.content;
  // Маркер {{LINKS}} необязателен — блок вставляется по позиции (prompt.link_position).
  // Если юзер вписал маркер — просим Claude его сохранить (приоритетный override).
  if (linkBlock && finalPrompt.includes(LINK_MARKER)) {
    finalPrompt += `\n\n(Оставь маркер ${LINK_MARKER} в тексте ровно один раз, не изменяй его.)`;
  }
  if (keyword) {
    // Если в промте есть плейсхолдер {{KEYWORD}} — подставляем туда; иначе дописываем инструкцию в конец.
    if (finalPrompt.includes(KEYWORD_MARKER)) {
      finalPrompt = finalPrompt.split(KEYWORD_MARKER).join(keyword);
    } else {
      finalPrompt += `\n\nЦелевой SEO-ключ: «${keyword}». Оптимизируй заголовок и текст под этот ключ — естественно, на немецком.`;
    }
  } else {
    // Без ключа — вычищаем маркер, чтобы он не попал в текст.
    finalPrompt = finalPrompt.split(KEYWORD_MARKER).join('');
  }

  // {{OFFERS}} → реальные бонус-фразы из блока ссылок (без URL), чтобы Claude вплёл их в начало под сниппет.
  if (finalPrompt.includes(OFFERS_MARKER)) {
    const phrases = offerPhrasesFromBlock(linkBlock);
    const offersText = phrases.length ? phrases.map((p) => `- ${p}`).join('\n') : '(офферов нет)';
    finalPrompt = finalPrompt.split(OFFERS_MARKER).join(offersText);
  }

  // Стоп-слова — проактивно просим их избегать (плюс постпроверка с перегенерацией в generateArticleForSite).
  if (stopWords.length) {
    finalPrompt += `\n\nЗАПРЕЩЁННЫЕ слова — не используй их (и их формы) ни в заголовке, ни в тексте: ${stopWords.join(', ')}.`;
  }

  return { site, prompt, key, finalPrompt, tags, linkBlock, linkBlockId, stopWords, warnings };
}

// Записать сгенерированную статью + её ссылки в БД. article = { title, body_html }.
// eventKind/eventMessage — запись в журнал событий статьи. Возвращает { id, linkCount }.
export function persistArticle(db, { site, prompt, keyId, tags, linkBlock, linkBlockId = null, article, eventKind = 'generated', eventMessage = 'Статья создана', keyword = null }) {
  // Блок ссылок подставляется ПРИ ПУБЛИКАЦИИ (links_pending=1) — тело храним СЫРЫМ. article_links тоже создаются при
  // публикации (актуальный блок). Без блока/отключён — просто убираем маркер {{LINKS}}, links_pending=0.
  const willInject = !!(linkBlockId && linkBlock);
  const pendingLinks = willInject ? (String(linkBlock).match(/\[url(nt)?=/gi) || []).length : 0;
  const body = willInject ? article.body_html : article.body_html.split(LINK_MARKER).join('');
  const insertArticle = db.prepare(`
    INSERT INTO articles (site_id, tracking_id, category, tags, title, body_html, status, claude_key_id, keyword, link_block_id, links_pending)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
  `);

  const tx = db.transaction((trackingId) =>
    insertArticle.run(site.id, trackingId, prompt.name || null, tags.join(',') || null, article.title, body, keyId, keyword, willInject ? linkBlockId : null, willInject ? 1 : 0).lastInsertRowid,
  );

  let aid;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      aid = tx(makeTrackingId(site.name));
      break;
    } catch (e) {
      if (!/UNIQUE/.test(e.message) || attempt === 4) throw e;
    }
  }
  logArticleEvent(db, aid, eventKind, `${eventMessage}${willInject ? ` (блок ссылок ~${pendingLinks} — при публикации)` : ''}`);
  return { id: aid, linkCount: pendingLinks };
}

// Ручное добавление статьи (без Claude): пользователь задаёт title+body_html и выбирает промт.
// Промт задаёт категорию/теги/блок ссылок — дальше та же сборка, что и у генерации (persistArticle).
// claude_key_id = null (нет вызова API). Возвращает { id, linkCount, tags, promptName, warnings }.
export function addManualArticle(db, { siteId, promptId, title, bodyHtml } = {}) {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site) throw new Error(`Сайт ${siteId} не найден.`);
  if (!promptId) throw new Error('Укажи промт (какой использовал).');
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ? AND site_id = ?').get(promptId, siteId);
  if (!prompt) throw new Error('Промт не найден для этого сайта.');
  if (!title || !title.trim()) throw new Error('Пустой заголовок.');
  if (!bodyHtml || !bodyHtml.trim()) throw new Error('Пустое тело статьи.');

  const tags = String(prompt.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const block = prompt.link_block_id ? db.prepare('SELECT * FROM link_blocks WHERE id = ? AND enabled = 1').get(prompt.link_block_id) : null;
  const linkBlock = block?.block || '';
  const { id, linkCount } = persistArticle(db, {
    site,
    prompt,
    keyId: null,
    tags,
    linkBlock,
    linkBlockId: block?.id || null,
    article: { title: title.trim(), body_html: bodyHtml },
    eventKind: 'manual',
    eventMessage: `Добавлена вручную (промт «${prompt.name || prompt.id}»)`,
  });
  const warnings = [];
  if (linkBlock && tags.length < 2) warnings.push('у промта меньше 2 тегов (для публикации нужно ≥2).');
  return { id, linkCount, tags, promptName: prompt.name, warnings };
}

// Сгенерировать статью (реалтайм). { siteId, promptId? } — promptId опц. (иначе активный промт сайта).
// Возвращает { id, title, linkCount, tags, usage, warnings, promptName }.
export async function generateArticleForSite(db, { siteId, promptId, maxTokens = 16000, keyword = null, backend = 'api', onStep } = {}) {
  const step = (m) => {
    console.log(m);
    if (onStep) onStep(m);
  };
  const ctx = prepareGeneration(db, { siteId, promptId, extra: 1, keyword, backend });
  const via = backend === 'cli' ? 'подписка (claude CLI)' : `ключ #${ctx.key.id}`;
  step(`Промт «${ctx.prompt.name || ctx.prompt.id}», ${via}${keyword ? `, под ключ «${keyword}»` : ''}.`);

  const model = process.env.CLAUDE_MODEL || 'claude-opus-4-8';
  // Генерируем; при попадании стоп-слов — перегенерируем (до STOPWORD_MAX_REGEN раз) с усиленным запретом.
  const maxAttempts = ctx.stopWords.length ? STOPWORD_MAX_REGEN : 1;
  let article;
  let hits = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = attempt === 1
      ? ctx.finalPrompt
      : `${ctx.finalPrompt}\n\nВ прошлой версии встретились ЗАПРЕЩЁННЫЕ слова: ${hits.join(', ')}. Полностью исключи их и любые их формы — перепиши.`;
    step(attempt === 1
      ? `Запрос в Claude (${model}, ${backend === 'cli' ? 'в рамках тарифа' : 'API'})${backend === 'cli' ? '' : ' — стриминг'}, обычно 30–60с…`
      : `Перегенерация (попытка ${attempt}/${maxAttempts}) — найдены стоп-слова: ${hits.join(', ')}.`);
    article = await generateArticle({ apiKey: ctx.key?.api_key, prompt, maxTokens, backend });
    if (ctx.key) markKeyUsed(ctx.key.id);
    hits = ctx.stopWords.length ? findStopWords(`${article.title}\n${stripHtml(article.body_html)}`, ctx.stopWords) : [];
    if (!hits.length) break;
  }
  if (hits.length) ctx.warnings.push(`после ${maxAttempts} попыток остались стоп-слова: ${hits.join(', ')} — сохранил как есть, проверь вручную.`);
  const u = article.usage || {};
  step(`Ответ получен (вход ${u.input_tokens ?? '?'} / выход ${u.output_tokens ?? '?'} токенов)${ctx.stopWords.length ? `, стоп-слов: ${hits.length ? hits.join(', ') : 'нет'}` : ''}. Сохраняю…`);

  const { id, linkCount } = persistArticle(db, {
    site: ctx.site,
    prompt: ctx.prompt,
    keyId: ctx.key?.id ?? null,
    tags: ctx.tags,
    linkBlock: ctx.linkBlock,
    linkBlockId: ctx.linkBlockId,
    article,
    keyword,
    eventMessage: `Сгенерирована через Claude (${backend === 'cli' ? 'подписка' : 'API'}, промт «${ctx.prompt.name || ctx.prompt.id}»${keyword ? `, ключ «${keyword}»` : ''})`,
  });
  step(`Статья #${id} создана: «${(article.title || '').slice(0, 70)}» (ссылок: ${linkCount}).`);

  return { id, title: article.title, linkCount, tags: ctx.tags, usage: article.usage, warnings: ctx.warnings, promptName: ctx.prompt.name };
}
