// Позиции статей в Google по их целевому ключу, по странам DACH (rank tracking).
// Основной способ — свой скрапер через Dolphin + прокси нужной страны (пул proxyPool); фолбэк — SERP API
// (DataForSEO) при блокировке/отсутствии прокси. Снимки храним во времени (article_ranks) → тренд позиции
// = оценка эффективности промта. Нашу статью в выдаче узнаём по сегменту URL «_a<id>» (стабильный id статьи).

import { launchProfileWithProxy, cleanupProfile } from './browser.js';
import { assignProxy } from './proxyPool.js';
import { parseProxy } from './accounts.js';
import { getSetting } from './settings.js';
import { getSolver } from './captcha/index.js';
import { utcStamp } from './time.js';

export const SERP_COUNTRIES = {
  at: { tld: 'at', gl: 'at', hl: 'de', location: 'Austria' },
  de: { tld: 'de', gl: 'de', hl: 'de', location: 'Germany' },
  ch: { tld: 'ch', gl: 'ch', hl: 'de', location: 'Switzerland' },
};
export const DACH = ['at', 'de', 'ch'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, spread) => sleep(base + Math.floor(Math.random() * spread)); // анти-бот: не частить к Google
const SORRY_WAIT_MS = Number(process.env.SERP_SORRY_WAIT_MS || 20000); // сколько ждать авто-решения капчи расширением, потом — ротация прокси

// Решатель капчи для SERP: отдельные настройки serp_captcha_* (напр. YesCaptcha — лучше берёт reCAPTCHA),
// иначе фолбэк на общий решатель. Запросы к сервису гоним через тот же прокси страны.
function serpSolver(db, proxy) {
  const provider = process.env.SERP_CAPTCHA_PROVIDER || getSetting(db, 'serp_captcha_provider') || '';
  const apiKey = process.env.SERP_CAPTCHA_API_KEY || getSetting(db, 'serp_captcha_api_key') || '';
  if (provider && apiKey) return getSolver(db, { proxy, provider, apiKey });
  return getSolver(db, { proxy }); // общий решатель (если задан)
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}
// Сервисные домены Google и инфраструктура выдачи — не результаты.
function isGoogleOwned(url) {
  const h = hostOf(url);
  return /(^|\.)google\.[a-z.]+$|(^|\.)gstatic\.com$|(^|\.)googleusercontent\.com$|(^|\.)youtube\.com$|(^|\.)googleadservices\.|schema\.org/.test(h) || h === '';
}

// Разобрать HTML выдачи Google → упорядоченный список URL органики (без дублей). Чистая функция (тестируема).
// Эвристика: ссылка-результат — это <a href="URL"> с заголовком <h3> вскоре после неё.
export function parseGoogleSerp(html) {
  const s = String(html || '');
  const urls = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw) return;
    let url = raw;
    const m = url.match(/^\/url\?(?:[^"]*&)?(?:q|url)=([^&]+)/); // старый формат /url?q=
    if (m) url = decodeURIComponent(m[1]);
    if (!/^https?:\/\//i.test(url)) return;
    if (isGoogleOwned(url)) return;
    const key = url.replace(/#.*$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    urls.push(url);
  };
  const re = /<a\s+[^>]*?href="([^"#]+)"[^>]*>(?:(?!<\/a>)[\s\S]){0,800}?<h3[\s>]/gi;
  let mm;
  while ((mm = re.exec(s)) !== null) push(mm[1]);
  return urls;
}

// Позиция нашего результата в списке URL. matchId — id статьи на сайте (из «_a<id>»). Чистая функция.
export function findPosition(urls, { matchId, domain } = {}) {
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    if (matchId && u.includes(`_a${matchId}`)) return { position: i + 1, url: u };
    if (!matchId && domain && hostOf(u).replace(/^www\./, '') === String(domain).replace(/^www\./, '')) return { position: i + 1, url: u };
  }
  return { position: null, url: null };
}

function matchIdOf(siteUrl) {
  return (String(siteUrl || '').match(/_a(\d+)/) || [])[1] || null;
}

export function saveRankSnapshot(db, articleId, { country, keyword, position = null, url = null, source, depth = null, error = null } = {}) {
  return db
    .prepare(
      `INSERT INTO article_ranks (article_id, captured_at, country, keyword, position, url, source, checked_depth, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(articleId, utcStamp(), country, keyword || null, position, url, source || null, depth, error).lastInsertRowid;
}

// Принять consent-плашку Google (EU): «Alle akzeptieren» — в основном документе или во фрейме consent.google.com.
async function acceptGoogleConsent(page) {
  const clickAccept = (frame) =>
    frame
      .evaluate(() => {
        const re = /^(alle akzeptieren|alle annehmen|accept all|ich stimme zu|zustimmen|i agree|akzeptieren|accept)$/i;
        const els = [...document.querySelectorAll('button, input[type=submit], input[type=button], div[role="button"], a[role="button"]')];
        const b = els.find((x) => {
          const t = (x.textContent || x.value || x.getAttribute('aria-label') || '').trim();
          return re.test(t);
        });
        if (b) {
          b.click();
          return true;
        }
        // запасной вариант: сабмит формы согласия
        const form = document.querySelector('form[action*="consent"], form[action*="save"]');
        const sb = form && form.querySelector('button, input[type=submit]');
        if (sb) {
          sb.click();
          return true;
        }
        return false;
      })
      .catch(() => false);
  try {
    if (await clickAccept(page)) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      return;
    }
    for (const f of page.frames()) {
      if (/consent\.google|consent|fundingchoices/i.test(f.url() || '')) {
        if (await clickAccept(f)) {
          await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          return;
        }
      }
    }
  } catch {
    // best-effort
  }
}

// Решить капчу на странице Google /sorry через reCAPTCHA-решатель (2captcha): sitekey + data-s → токен →
// вставить в g-recaptcha-response и отправить форму. Best-effort; на провале выше — ротация прокси.
async function solveSorryCaptcha(page, { solver, log = () => {} }) {
  // data-s одноразовый и лежит как атрибут .g-recaptcha[data-s] (фолбэк — поиск в исходнике страницы).
  const info = await page
    .evaluate(() => {
      const el = document.querySelector('.g-recaptcha[data-sitekey], [data-sitekey]');
      if (!el) return null;
      let dataS = el.getAttribute('data-s') || '';
      if (!dataS) {
        const html = document.documentElement.innerHTML;
        const m = html.match(/data-s="([^"]+)"/) || html.match(/"data-s"\s*[:=]\s*"([^"]+)"/);
        if (m) dataS = m[1];
      }
      return { siteKey: el.getAttribute('data-sitekey'), dataS };
    })
    .catch(() => null);
  if (!info?.siteKey) throw new Error('на /sorry не найден sitekey reCAPTCHA');
  log(`Решаю капчу Google /sorry через ${solver.name || 'решатель'}…`);
  const token = await solver.solveRecaptchaV2({ siteKey: info.siteKey, pageUrl: page.url(), dataS: info.dataS });
  // Токен → в g-recaptcha-response, отправляем именно форму captcha-form (как в доке 2captcha).
  await page.evaluate((tok) => {
    const ta = document.getElementById('g-recaptcha-response') || document.querySelector('textarea[name="g-recaptcha-response"]');
    if (ta) {
      ta.style.display = 'block';
      ta.value = tok;
    }
    const form = document.querySelector('#captcha-form, form[name="captcha-form"], form[action*="sorry"], form');
    if (form) form.submit();
  }, token);
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
}

// Живой поиск в Google с ПАГИНАЦИЕЙ (Google игнорирует num=100 → идём по страницам &start=0,10,20…).
// Возвращает { urls, h3count } — органика по порядку до maxPages*10. solver (опц.) решает капчу /sorry.
// matchId (опц.) — как только наш результат найден, глубже не идём (экономия). serpBlocked → ретрай прокси выше.
async function googleSearchInPage(page, { keyword, country, solver = null, matchId = null, maxPages = 5, log = () => {} }) {
  const c = SERP_COUNTRIES[country];
  if (!c) throw new Error(`Неизвестная страна: ${country}`);
  const all = [];
  const seen = new Set();
  let totalH3 = 0;
  for (let p = 0; p < maxPages; p++) {
    const url = `https://www.google.${c.tld}/search?q=${encodeURIComponent(keyword)}&hl=${c.hl}&gl=${c.gl}&pws=0&start=${p * 10}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await acceptGoogleConsent(page);
    if (/\/sorry\//.test(page.url())) {
      // 1) Основной путь — расширение YesCaptcha решает капчу В БРАУЗЕРЕ (правильный data-s/IP/cookies,
      //    авто-клик чекбокса + авто-сабмит). Ждём до SERP_SORRY_WAIT_MS, потом уходим в ротацию прокси.
      log('Капча /sorry — жду авто-решения расширением…');
      const sorryDeadline = Date.now() + SORRY_WAIT_MS;
      while (Date.now() < sorryDeadline && /\/sorry\//.test(page.url())) await sleep(2500);
      // 2) Фолбэк — наш ручной solver (на случай, если расширение не настроено/не справилось).
      if (solver && /\/sorry\//.test(page.url())) {
        await solveSorryCaptcha(page, { solver, log }).catch((e) => log(`капча /sorry (ручной фолбэк): ${e.message}`));
      }
      if (/\/sorry\//.test(page.url())) {
        const e = new Error('Google /sorry (капча не решена) — ротация прокси.');
        e.serpBlocked = true;
        throw e;
      }
      log('Капча /sorry пройдена.');
    }
    await page.waitForSelector('h3', { timeout: 12000 }).catch(() => {});
    let html = await page.content();
    let h3 = (html.match(/<h3/g) || []).length;
    if (h3 === 0 && p === 0) {
      // консент мог не прожаться — ещё попытка
      await acceptGoogleConsent(page);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForSelector('h3', { timeout: 12000 }).catch(() => {});
      html = await page.content();
      h3 = (html.match(/<h3/g) || []).length;
    }
    if (h3 === 0) {
      if (p === 0) {
        const e = new Error('Пустая страница выдачи (консент/бот) — неинформативно.');
        e.serpBlocked = true;
        throw e;
      }
      break; // дальше страниц нет
    }
    totalH3 += h3;
    const urls = parseGoogleSerp(html);
    if (!urls.length) break;
    let added = 0;
    for (const u of urls) {
      const k = u.replace(/#.*$/, '');
      if (!seen.has(k)) {
        seen.add(k);
        all.push(u);
        added += 1;
      }
    }
    if (matchId && all.some((u) => u.includes('_a' + matchId))) break; // нашли — глубже не нужно
    if (!added) break; // новых результатов нет — конец выдачи
    await jitter(700, 800); // пауза между страницами выдачи
  }
  return { urls: all, h3count: totalH3 };
}

// Фолбэк через SERP API (DataForSEO Live Advanced). Возвращает упорядоченный список URL органики.
async function googleSerpApi(db, { keyword, country }) {
  const login = process.env.SERP_LOGIN || getSetting(db, 'serp_login');
  const password = process.env.SERP_PASSWORD || getSetting(db, 'serp_password');
  if (!login || !password) {
    const e = new Error('SERP API не настроен (нет логина/пароля DataForSEO в Настройках).');
    e.noApi = true;
    throw e;
  }
  const c = SERP_COUNTRIES[country];
  const auth = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
  const body = JSON.stringify([{ keyword, location_name: c.location, language_code: 'de', device: 'desktop', depth: 100 }]);
  const res = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`SERP API HTTP ${res.status}`);
  const data = await res.json();
  const items = data?.tasks?.[0]?.result?.[0]?.items || [];
  return items
    .filter((it) => it.type === 'organic')
    .sort((a, b) => (a.rank_absolute || 0) - (b.rank_absolute || 0))
    .map((it) => it.url)
    .filter(Boolean);
}

// Проверить позицию одной статьи в одной стране. Свой скрапер с РЕТРАЯМИ по разным прокси:
// выдача свежей статьи по разным IP/дата-центрам Google нестабильна → присутствие хотя бы на одном
// = реальная позиция (берём лучшую/минимальную). Пустая страница (консент/бот) — НЕ «не найдено»,
// а повод попробовать другой прокси. Если все попытки пустые/без прокси — фолбэк SERP API.
async function rankOne(db, { article, country, log, tries = 3, pages = 5 }) {
  const matchId = matchIdOf(article.site_url);
  const kw = article.keyword;
  let best = null; // лучшая (минимальная) найденная позиция
  let bestUrl = null;
  let sawResults = false; // была ли хоть одна непустая выдача (значит «отсутствие» — настоящее)
  let depthSeen = 0;

  for (let attempt = 1; attempt <= tries; attempt++) {
    if (attempt > 1) await jitter(1500, 1500); // кулдаун перед ретраем другим прокси
    let proxyUrl = null;
    try {
      proxyUrl = assignProxy(db, { country });
    } catch {
      proxyUrl = null;
    }
    if (!proxyUrl) {
      log(`${country}: нет прокси в пуле${attempt === 1 ? '' : ' (для ретрая)'} — фолбэк API.`);
      break;
    }
    let browser;
    let page;
    let pid = null;
    try {
      const proxy = parseProxy(proxyUrl);
      const launched = await launchProfileWithProxy({ proxy });
      browser = launched.browser;
      page = launched.page;
      pid = launched.profileId;
      const solver = serpSolver(db, proxy); // решатель /sorry (YesCaptcha/2captcha) — через тот же прокси
      // Глубокий скан только до ПЕРВОЙ чистой выдачи (точная позиция вглубь); дальнейшие ретраи нужны лишь
      // на вариативность дата-центров (присутствуем/нет) → хватит 1-й страницы — резко дешевле для «не найдено».
      const maxPages = sawResults ? 1 : pages;
      const { urls, h3count } = await googleSearchInPage(page, { keyword: kw, country, solver, matchId, maxPages, log });
      sawResults = true;
      depthSeen = Math.max(depthSeen, urls.length);
      const { position, url } = findPosition(urls, { matchId });
      if (position != null && (best == null || position < best)) {
        best = position;
        bestUrl = url;
      }
      log(`${country} #${article.id} попытка ${attempt}/${tries}: ${position ? '#' + position : 'не найдена среди ' + urls.length} (h3=${h3count})`);
      if (best != null) break; // нашли — дальше не нужно
    } catch (e) {
      log(`${country} #${article.id} попытка ${attempt}/${tries}: ${e.message}`);
    } finally {
      await cleanupProfile(browser, pid);
    }
  }

  if (best != null) {
    saveRankSnapshot(db, article.id, { country, keyword: kw, position: best, url: bestUrl, source: 'dolphin', depth: depthSeen });
    return { country, position: best, source: 'dolphin' };
  }
  if (sawResults) {
    // была реальная выдача, но нас в ней нет → не на 1-й странице (Google отдаёт ~топ-10)
    saveRankSnapshot(db, article.id, { country, keyword: kw, position: null, url: null, source: 'dolphin', depth: depthSeen });
    log(`${country} #${article.id}: не на 1-й странице (проверено прокси: ${tries}).`);
    return { country, position: null, source: 'dolphin' };
  }
  // Только пустые/блок/нет прокси → SERP API.
  try {
    const urls = await googleSerpApi(db, { keyword: kw, country });
    const { position, url } = findPosition(urls, { matchId });
    saveRankSnapshot(db, article.id, { country, keyword: kw, position, url, source: 'api', depth: urls.length });
    log(`${country} #${article.id} (API): ${position ? '#' + position : 'не в топ-' + urls.length}`);
    return { country, position, source: 'api' };
  } catch (e) {
    saveRankSnapshot(db, article.id, { country, keyword: kw, position: null, url: null, source: 'api', error: e.message });
    log(`${country} #${article.id}: ${e.message}`);
    return { country, position: null, error: e.message };
  }
}

// Проверить позиции ОДНОЙ статьи по странам. Возвращает [{country,position,source?,error?}].
export async function checkArticleRank(db, articleId, { countries = DACH, pages = 5, onStep } = {}) {
  const log = (m) => {
    console.log(m);
    if (onStep) onStep(m);
  };
  const a = db.prepare('SELECT id, keyword, site_url, status, site_deleted_at FROM articles WHERE id = ?').get(articleId);
  if (!a) throw new Error(`Статья ${articleId} не найдена.`);
  if (!a.keyword) throw new Error('У статьи нет целевого ключа — нечего проверять.');
  if (!matchIdOf(a.site_url)) throw new Error('У статьи нет URL на сайте — позицию проверять не по чему.');
  if (a.site_deleted_at) log('Внимание: статья снята с сайта — она вряд ли в выдаче.');
  const out = [];
  for (const country of countries) {
    log(`=== ${country.toUpperCase()} ===`);
    out.push(await rankOne(db, { article: a, country, log, tries: 3, pages }));
  }
  return out;
}

// Проверить позиции по всем живым статьям сайта (с ключом и URL). По странам: одна сессия Dolphin на страну,
// цикл по статьям (переиспускаем сессию/прокси); при блокировке — остаток страны добиваем через API.
export async function checkRanksForSite(db, siteId, { countries = DACH, pages = 3, onStep } = {}) {
  const log = (m) => {
    console.log(m);
    if (onStep) onStep(m);
  };
  const arts = db
    .prepare(
      `SELECT id, keyword, site_url FROM articles
       WHERE site_id = ? AND status = 'published' AND site_deleted_at IS NULL
         AND keyword IS NOT NULL AND keyword <> '' AND site_url LIKE '%\\_a%' ESCAPE '\\'
       ORDER BY id`,
    )
    .all(siteId);
  if (!arts.length) {
    log('Нет живых статей с ключом и URL — нечего проверять.');
    return { total: 0, ok: 0, fail: 0 };
  }
  let found = 0;
  let notFound = 0;
  let errors = 0;
  for (const a of arts) {
    log(`--- #${a.id} «${a.keyword}» ---`);
    for (const country of countries) {
      const r = await rankOne(db, { article: a, country, log, tries: 2, pages });
      if (r.error) errors += 1;
      else if (r.position != null) found += 1;
      else notFound += 1;
    }
  }
  log(`Готово: в топе ${found}, не на 1-й странице ${notFound}, ошибок ${errors} (статей ${arts.length} × стран ${countries.length}).`);
  return { total: arts.length * countries.length, ok: found + notFound, fail: errors, found, notFound };
}

// Диагностика скрапера: что реально вернул Google по ключу статьи (для отладки парсера/локали).
export async function diagnoseRank(db, articleId, country = 'at') {
  const a = db.prepare('SELECT id, keyword, site_url FROM articles WHERE id = ?').get(articleId);
  if (!a) throw new Error('Статья не найдена.');
  const matchId = matchIdOf(a.site_url);
  const proxyUrl = assignProxy(db, { country });
  if (!proxyUrl) throw new Error(`Нет прокси страны ${country}.`);
  const c = SERP_COUNTRIES[country];
  const launched = await launchProfileWithProxy({ proxy: parseProxy(proxyUrl) });
  const { browser, page, profileId } = launched;
  try {
    const url = `https://www.google.${c.tld}/search?q=${encodeURIComponent(a.keyword)}&num=100&hl=${c.hl}&gl=${c.gl}&pws=0`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await acceptGoogleConsent(page);
    const html = await page.content();
    const urls = parseGoogleSerp(html);
    return {
      keyword: a.keyword,
      matchId,
      finalUrl: page.url(),
      htmlLen: html.length,
      h3count: (html.match(/<h3/g) || []).length,
      parsedCount: urls.length,
      parsedTop: urls.slice(0, 15),
      containsOurId: matchId ? html.includes('_a' + matchId) : false,
      containsHost: html.includes('meinbezirk.at'),
      blocked: /\/sorry\/|unusual traffic|recaptcha/i.test(html) || /\/sorry\//.test(page.url()),
    };
  } finally {
    await cleanupProfile(browser, profileId);
  }
}

// Последняя позиция на статью×страну. Возвращает Map(article_id -> { at:{position,...}, de:{...}, ch:{...} }).
export function latestRanks(db, siteId) {
  const rows = db
    .prepare(
      `WITH latest AS (
         SELECT r.* FROM article_ranks r
         JOIN (SELECT article_id, country, MAX(id) mid FROM article_ranks GROUP BY article_id, country) m ON m.mid = r.id
       )
       SELECT l.article_id, l.country, l.position, l.captured_at, l.source, l.error
       FROM latest l JOIN articles a ON a.id = l.article_id
       WHERE a.site_id = ?`,
    )
    .all(siteId);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.article_id)) map.set(r.article_id, {});
    map.get(r.article_id)[r.country] = { position: r.position, captured_at: r.captured_at, source: r.source, error: r.error };
  }
  return map;
}
