// Оркестрация SEO-анализа ключей: SEMrush (API/UI) → метрики в БД → score → шорт-лист от Claude.
// Score заточен под КЛИКИ по партнёрским линкам: коммерческое/транзакционное намерение + объём + достижимость.

import Anthropic from '@anthropic-ai/sdk';
import { pickKey, markKeyUsed } from './keys.js';
import { resolveSemrushAccount, setUnitsBalance, saveAccountCookies, saveUiLimits } from './semrushAccounts.js';
import { parseProxy } from './accounts.js';
import { launchProfileWithProxy, cleanupProfile, captureCookies, restoreCookies } from './browser.js';
import * as api from './research/api.js';
import * as ui from './research/ui.js';

export const DB_COUNTRY = { de: 'Germany', at: 'Austria', ch: 'Switzerland' };

// Вес намерения. SEMrush 'In': коды 0=commercial,1=informational,2=navigational,3=transactional (или словом).
export function intentWeight(intent) {
  if (!intent) return 0.6;
  let best = 0.5;
  for (const c of String(intent).toLowerCase().split(',').map((x) => x.trim())) {
    let w = 0.5;
    if (c === '3' || c.includes('transac')) w = 1.0;
    else if (c === '0' || c.includes('commerc')) w = 0.9;
    else if (c === '2' || c.includes('navig')) w = 0.4;
    else if (c === '1' || c.includes('inform')) w = 0.5;
    if (w > best) best = w;
  }
  return best;
}

// Классификация «оставить/отклонить + причина». Мусор не выбрасываем — храним с пометкой (в выгрузку «хороших» не идёт).
const SPAM_TOKENS = ['bestecasinobonussen', '600freespins', 'freespins', 'casinobonussen', 'casino-bonus', 'gratisspins'];
export function classifyKeyword({ phrase } = {}) {
  const p = String(phrase || '').toLowerCase();
  if (/\bwww\.|https?:\/\//.test(p)) return { rejected: 1, reason: 'содержит www/URL — паразитная выдача чужого сайта' };
  for (const t of SPAM_TOKENS) if (p.includes(t)) return { rejected: 1, reason: `сторонний бонус/казино-домен («${t}»)` };
  return { rejected: 0, reason: null };
}

// Чистая функция оценки «насколько ключ перспективен для трафика/кликов».
export function scoreKeyword({ volume, kd, cpc, intent } = {}) {
  const volF = Math.log10(Math.max(0, volume || 0) + 10); // объём (лог)
  const kdv = kd == null ? 50 : kd; // неизвестный KD → нейтрально
  const reach = Math.max(0.05, 1 - kdv / 100); // ниже сложность → выше шанс попасть в топ
  const cpcF = 1 + Math.min(2, (cpc || 0) / 2); // CPC — прокси коммерческой ценности
  return +(volF * reach * cpcF * intentWeight(intent)).toFixed(3);
}

async function analyzeKeywords(db, run, rows) {
  const key = pickKey();
  if (!key) return null;
  const top = rows.slice(0, 30).map((r) => ({ k: r.phrase, db: r.database, vol: r.volume, kd: r.kd, intent: r.intent, cpc: r.cpc, score: r.score }));
  const prompt = `Ты SEO-аналитик. Ниша: онлайн-беттинг, рынок DACH. Мы публикуем статьи на новостном сайте meinbezirk.at (высокий авторитет домена) и вставляем партнёрские ссылки на букмекеров. Цель — ключи, под которые статья реально встанет в поиск и даст КЛИКИ по нашим ссылкам.
Вот топ кандидатов из SEMrush (vol=объём, kd=сложность %, intent SEMrush-коды 0=commercial/1=informational/2=navigational/3=transactional, cpc, score=наша оценка):
${JSON.stringify(top, null, 0)}
Дай краткий шорт-лист 5–10 ключей «что тестить в первую очередь» с обоснованием (объём vs сложность vs намерение), и для топ-3 — короткий контент-угол под новостную статью meinbezirk. Ответ на русском, маркдауном, без воды.`;
  try {
    const client = new Anthropic({ apiKey: key.api_key });
    const msg = await client.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-8',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });
    markKeyUsed(key.id);
    return (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || null;
  } catch (e) {
    return `_Анализ Claude не выполнен: ${e.message}_`;
  }
}

// Главная оркестрация. limit — ключей на seed; analyze — звать ли Claude (платно).
export async function runKeywordResearch(db, { runId, limit = 100, analyze = true, onStep = () => {} } = {}) {
  const step = (m) => onStep(m);
  const run = db.prepare('SELECT * FROM kw_runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`Прогон ${runId} не найден.`);
  const seeds = JSON.parse(run.seeds || '[]').filter(Boolean);
  const databases = JSON.parse(run.databases || '[]').filter(Boolean);
  if (!seeds.length || !databases.length) throw new Error('Пустые seeds или базы.');

  const account = resolveSemrushAccount(db, run.account_id);
  const useUi = run.source === 'ui' || run.source === 'auto';
  step(`Аккаунт «${account.label || account.email || account.id}», источник ${run.source}: ${databases.join('/')} × ${seeds.length} seed.`);

  let bal0 = null;
  if (!useUi) {
    if (!account.api_key) throw new Error('У выбранного аккаунта нет API-ключа.');
    bal0 = await api.unitsBalance(account.api_key);
    if (bal0 != null) {
      setUnitsBalance(db, account.id, bal0);
      step(`Остаток API-юнитов: ${bal0}.`);
    }
  }
  let unitsUsed = 0;

  const upsert = db.prepare(`INSERT INTO kw_keywords (run_id, source, database, phrase, volume, cpc, competition, kd, intent, trend, results, score, rejected, reject_reason)
    VALUES (@run_id, @source, @database, @phrase, @volume, @cpc, @competition, @kd, @intent, @trend, @results, @score, @rejected, @reject_reason)
    ON CONFLICT(run_id, database, phrase) DO UPDATE SET volume=excluded.volume, cpc=excluded.cpc, competition=excluded.competition, kd=excluded.kd, intent=excluded.intent, trend=excluded.trend, results=excluded.results, score=excluded.score, rejected=excluded.rejected, reject_reason=excluded.reject_reason`);
  const store = (src, database, row) => {
    const cls = classifyKeyword(row);
    upsert.run({ run_id: runId, source: src, database, phrase: row.phrase, volume: row.volume ?? null, cpc: row.cpc ?? null, competition: row.competition ?? null, kd: row.kd ?? null, intent: row.intent ?? null, trend: row.trend ?? null, results: row.results ?? null, score: scoreKeyword(row), rejected: cls.rejected, reject_reason: cls.reason });
  };

  // 1) Обнаружение по seed × база — UI (Dolphin, KD inline, без юнитов) или API (юниты).
  if (useUi) {
    const proxy = account.proxy ? parseProxy(account.proxy) : null;
    if (!proxy) throw new Error('У аккаунта нет прокси — UI-путь требует прокси (правило профиля).');
    let browser;
    let profileId;
    try {
      const launched = await launchProfileWithProxy({ proxy });
      browser = launched.browser;
      profileId = launched.profileId;
      const page = launched.page;
      step(`Профиль ${profileId} поднят. Авторизация SEMrush…`);
      let logged = false;
      if (Array.isArray(account.cookies) && account.cookies.length) {
        await restoreCookies(page, account.cookies);
        if (await ui.isLoggedIn(page)) {
          logged = true;
          step('Сессия восстановлена из cookies — логин пропущен.');
        }
      }
      if (!logged) {
        await ui.login(page, { email: account.email, password: account.password, log: step });
        try {
          saveAccountCookies(db, account.id, await captureCookies(page));
        } catch {
          // не критично
        }
      }
      let lastLimits = null;
      for (const database of databases) {
        for (const seed of seeds) {
          step(`[${database}] Keyword Magic «${seed}»…`);
          const res = await ui.keywordMagic(page, { seed, database, limit, log: step });
          for (const row of res.keywords) store('ui', database, row);
          if (res.limits) lastLimits = res.limits;
        }
      }
      if (lastLimits) saveUiLimits(db, account.id, lastLimits);
      // Пересохраняем cookies: SEMrush продлевает сессию — храним свежие, чтобы реже логиниться/вставлять заново.
      try {
        saveAccountCookies(db, account.id, await captureCookies(page));
        step('Сессия SEMrush обновлена (cookies пересохранены).');
      } catch {
        // не критично
      }
    } finally {
      await cleanupProfile(browser, profileId);
    }
  } else {
    outer: for (const database of databases) {
      for (const seed of seeds) {
        step(`[${database}] обнаружение по «${seed}»…`);
        const r = await api.discoverKeywords({ key: account.api_key, phrase: seed, database, limit });
        if (r.error) {
          step(`  ошибка: ${r.error}`);
          continue;
        }
        unitsUsed += r.count * (api.UNIT_COST.phrase_fullsearch || 20);
        for (const row of r.rows) store('api', database, row);
        step(`  +${r.count} ключей.`);
        if (bal0 != null && unitsUsed > bal0 - 500) {
          step('Внимание: юниты на исходе — останавливаю обнаружение.');
          break outer;
        }
      }
    }
  }

  // 2) Реальный Keyword Difficulty по топ-кандидатам (только API; UI отдаёт KD сразу).
  const top = useUi ? [] : db.prepare('SELECT id, database, phrase, volume, cpc, intent FROM kw_keywords WHERE run_id = ? AND kd IS NULL AND rejected = 0 ORDER BY score DESC LIMIT 100').all(runId);
  const byDb = {};
  for (const k of top) (byDb[k.database] ||= []).push(k);
  const upd = db.prepare('UPDATE kw_keywords SET kd = ?, score = ? WHERE id = ?');
  for (const [database, items] of Object.entries(byDb)) {
    if (bal0 != null && unitsUsed > bal0 - 500) {
      step('Внимание: юниты на исходе — пропускаю Keyword Difficulty.');
      break;
    }
    const phrases = items.map((i) => i.phrase).slice(0, 100);
    step(`[${database}] Keyword Difficulty по ${phrases.length} кандидатам…`);
    const r = await api.keywordDifficulty({ key: account.api_key, phrases, database });
    if (r.error) {
      step(`  KD ошибка: ${r.error}`);
      continue;
    }
    unitsUsed += r.count * (api.UNIT_COST.phrase_kdi || 50);
    const kdMap = {};
    for (const row of r.rows) kdMap[String(row.phrase).toLowerCase()] = row.kd;
    for (const it of items) {
      const kd = kdMap[String(it.phrase).toLowerCase()];
      if (kd == null) continue;
      upd.run(kd, scoreKeyword({ volume: it.volume, cpc: it.cpc, intent: it.intent, kd }), it.id);
    }
  }

  // 3) Анализ Claude по топу (опц.).
  const ranked = db.prepare('SELECT database, phrase, volume, kd, cpc, intent, score FROM kw_keywords WHERE run_id = ? AND rejected = 0 ORDER BY score DESC LIMIT 60').all(runId);
  if (analyze && ranked.length) {
    step('Анализ Claude по топ-кандидатам…');
    const analysisText = await analyzeKeywords(db, run, ranked);
    if (analysisText) db.prepare('UPDATE kw_runs SET analysis = ? WHERE id = ?').run(analysisText, runId);
  }

  const total = db.prepare('SELECT COUNT(*) c FROM kw_keywords WHERE run_id = ?').get(runId).c;
  db.prepare("UPDATE kw_runs SET units_used = ?, status = 'done' WHERE id = ?").run(unitsUsed, runId);
  let bal1 = null;
  if (!useUi && account.api_key) {
    bal1 = await api.unitsBalance(account.api_key);
    if (bal1 != null) setUnitsBalance(db, account.id, bal1);
  }
  step(`Готово. Ключей: ${total}${useUi ? ' (UI, без юнитов)' : `, потрачено ~${unitsUsed} юнитов${bal1 != null ? `, остаток ${bal1}` : ''}`}.`);
  return { keywords: total, unitsUsed };
}
