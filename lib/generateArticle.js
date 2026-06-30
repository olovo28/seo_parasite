// Оркестрация генерации статьи по ПРОМТУ: текст промта → Claude → запись в БД.
// У промта есть свой авторский блок ссылок (BBCode) и теги. Блок вставляется по {{LINKS}},
// в его URL добавляются Binom-параметры (s1=статья, s2=порядковый номер ссылки).
// prepareGeneration/persistArticle переиспользуют и реалтайм (этот файл), и батч (lib/batch.js).

import { pickKey, markKeyUsed } from './keys.js';
import { generateArticle } from './claude.js';
import { injectBinomLinks, insertLinkBlockMulti, offerPhrasesFromBlock } from './linkblock.js';
import { logArticleEvent } from './events.js';

const LINK_MARKER = '{{LINKS}}';
const KEYWORD_MARKER = '{{KEYWORD}}'; // место в промте, куда подставляется целевой ключ при генерации по списку
const OFFERS_MARKER = '{{OFFERS}}'; // место в промте → подставляются ТЕКСТОВЫЕ бонус-фразы из link_block (без URL)

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
  const linkBlock = prompt.link_block || '';
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

  return { site, prompt, key, finalPrompt, tags, linkBlock, warnings };
}

// Записать сгенерированную статью + её ссылки в БД. article = { title, body_html }.
// eventKind/eventMessage — запись в журнал событий статьи. Возвращает { id, linkCount }.
export function persistArticle(db, { site, prompt, keyId, tags, linkBlock, article, eventKind = 'generated', eventMessage = 'Статья создана', keyword = null }) {
  const insertArticle = db.prepare(`
    INSERT INTO articles (site_id, tracking_id, category, tags, title, body_html, status, claude_key_id, keyword)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `);
  const insertLink = db.prepare(`INSERT INTO article_links (article_id, link_id, anchor, base_url, final_url) VALUES (?, ?, ?, ?, ?)`);

  function buildBodyAndLinks(trackingId) {
    let body = article.body_html;
    let links = [];
    if (linkBlock) {
      const inj = injectBinomLinks(linkBlock, {
        articleParam: site.binom_param_article,
        linkParam: site.binom_param_link,
        trackingId,
      });
      links = inj.links;
      if (body.includes(LINK_MARKER)) {
        // приоритет: юзер сам поставил маркер(ы) — заменяем ВСЕ вхождения на блок (split/join: $ в блоке не интерпретируется)
        body = body.split(LINK_MARKER).join(inj.block);
      } else {
        // иначе вставляем по выбранным позициям относительно заголовков (можно несколько — блок продублируется)
        const positions = String(prompt.link_position || '1').split(',').map((s) => s.trim()).filter(Boolean);
        body = insertLinkBlockMulti(body, inj.block, positions.length ? positions : ['1']);
      }
    } else {
      body = body.split(LINK_MARKER).join('');
    }
    return { body, links };
  }

  const tx = db.transaction((trackingId) => {
    const { body, links } = buildBodyAndLinks(trackingId);
    const aid = insertArticle.run(site.id, trackingId, prompt.name || null, tags.join(',') || null, article.title, body, keyId, keyword).lastInsertRowid;
    for (const l of links) insertLink.run(aid, l.link_id, l.anchor, l.base_url, l.final_url);
    return { aid, count: links.length };
  });

  let result;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      result = tx(makeTrackingId(site.name));
      break;
    } catch (e) {
      if (!/UNIQUE/.test(e.message) || attempt === 4) throw e;
    }
  }
  logArticleEvent(db, result.aid, eventKind, `${eventMessage} (ссылок: ${result.count})`);
  return { id: result.aid, linkCount: result.count };
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
  const linkBlock = prompt.link_block || '';
  const { id, linkCount } = persistArticle(db, {
    site,
    prompt,
    keyId: null,
    tags,
    linkBlock,
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
  step(`Запрос в Claude (${model}, ${backend === 'cli' ? 'в рамках тарифа' : 'API'})${backend === 'cli' ? '' : ' — стриминг'}, обычно 30–60с…`);
  const article = await generateArticle({ apiKey: ctx.key?.api_key, prompt: ctx.finalPrompt, maxTokens, backend });
  if (ctx.key) markKeyUsed(ctx.key.id);
  const u = article.usage || {};
  step(`Ответ получен (вход ${u.input_tokens ?? '?'} / выход ${u.output_tokens ?? '?'} токенов). Сохраняю…`);

  const { id, linkCount } = persistArticle(db, {
    site: ctx.site,
    prompt: ctx.prompt,
    keyId: ctx.key?.id ?? null,
    tags: ctx.tags,
    linkBlock: ctx.linkBlock,
    article,
    keyword,
    eventMessage: `Сгенерирована через Claude (${backend === 'cli' ? 'подписка' : 'API'}, промт «${ctx.prompt.name || ctx.prompt.id}»${keyword ? `, ключ «${keyword}»` : ''})`,
  });
  step(`Статья #${id} создана: «${(article.title || '').slice(0, 70)}» (ссылок: ${linkCount}).`);

  return { id, title: article.title, linkCount, tags: ctx.tags, usage: article.usage, warnings: ctx.warnings, promptName: ctx.prompt.name };
}
