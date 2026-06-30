// UI-драйвер SEMrush через Dolphin: логин + Keyword Magic. Данные берём НЕ из таблицы/экспорта,
// а перехватом внутреннего JSON-RPC (kmtgw/v2/webapi) — структурно, со всеми метриками включая KD.
// Жжёт UI-лимиты подписки (не API-юниты). Хрупко (бот-защита) — детектим разлогин/блок.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dismissCookies(page) {
  await page.evaluate(() => {
    const b = document.querySelector('.ch2-deny-all-btn') || document.querySelector('.ch2-allow-all-btn');
    if (b) b.click();
  }).catch(() => {});
}

// Открыть страницу только-для-залогиненных; незалогиненного уведёт на /login.
export async function isLoggedIn(page, { origin = 'https://www.semrush.com' } = {}) {
  try {
    await page.goto(`${origin}/analytics/keywordmagic/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return !page.url().includes('/login');
  } catch {
    return false;
  }
}

export async function login(page, { email, password, log = console.log } = {}) {
  if (!email || !password) throw new Error('У SEMrush-аккаунта нет email/пароля для UI-логина.');
  log('Логин в SEMrush…');
  await page.goto('https://www.semrush.com/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dismissCookies(page);
  await page.waitForSelector('#email', { visible: true, timeout: 20000 });
  await page.type('#email', email, { delay: 25 });
  await page.type('#password', password, { delay: 25 });
  await Promise.all([
    page.evaluate(() => document.querySelector('[data-test="login-page__btn-login"]')?.click()),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
  ]);
  await sleep(2500);
  const blocked = await page.evaluate(() => /recaptcha|captcha|disable_soft|unusual activity|ungewöhnlich/i.test(document.body?.innerText || '') || /\/login\/disable/i.test(location.href)).catch(() => false);
  if (page.url().includes('/login') || blocked) {
    const e = new Error('SEMrush заблокировал авто-вход (reCAPTCHA / «unusual activity»). Войди в SEMrush вручную и вставь cookies (Cookie-Editor JSON) в аккаунт — драйвер пойдёт по сессии без логина.');
    e.needLogin = true;
    throw e;
  }
  log('SEMrush: вход выполнен.');
}

// kmtgw-ключ → наш формат.
function mapKw(k) {
  return {
    phrase: k.phrase,
    database: k.database,
    volume: k.volume ?? null,
    cpc: k.cpc ?? null,
    competition: k.competition_level ?? null,
    kd: k.difficulty ?? null,
    intent: Array.isArray(k.intents) ? k.intents.join(',') : (k.intents ?? null),
    results: k.results ?? null,
    trend: Array.isArray(k.trend) ? k.trend.join(',') : null,
  };
}

// Собрать ключи Keyword Magic по seed: навигация + перехват kmtgw JSON-RPC + скролл для догрузки.
export async function keywordMagic(page, { seed, database, limit = 200, log = console.log } = {}) {
  const collected = new Map();
  let limits = null;
  const onResp = async (res) => {
    try {
      if (!/\/kmtgw\//.test(res.url())) return;
      if (!/json/i.test(res.headers()['content-type'] || '')) return;
      const j = await res.json().catch(() => null);
      const r = j?.result;
      if (r && (r.remaining_updates != null || r.rows_count != null)) {
        limits = { remaining_updates: r.remaining_updates, max_updates: r.max_updates, rows_count: r.rows_count, trial_status: r.trial_status };
      }
      const arr = r?.keywords;
      if (!Array.isArray(arr)) return;
      for (const k of arr) if (k?.phrase && !collected.has(k.phrase)) collected.set(k.phrase, mapKw(k));
    } catch {
      // игнор
    }
  };
  page.on('response', onResp);
  try {
    await page.goto(`https://www.semrush.com/analytics/keywordmagic/?q=${encodeURIComponent(seed)}&db=${database}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(6000);
    if (page.url().includes('/login')) {
      const e = new Error('SEMrush: разлогинило на Keyword Magic.');
      e.needLogin = true;
      throw e;
    }
    // Скролл — виртуализированная таблица догружает страницы (новые kmtgw-ответы).
    // Ранний выход: если 3 скролла подряд без прироста — больше не подгружается, не тратим время.
    let prev = 0;
    let stagnant = 0;
    for (let i = 0; i < 25 && collected.size < limit; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, 3000);
        const grid = document.querySelector('[role="grid"]') || document.querySelector('main');
        if (grid) grid.scrollTop = grid.scrollHeight;
      }).catch(() => {});
      await sleep(1100);
      if (collected.size === prev) {
        if (++stagnant >= 3) break;
      } else {
        stagnant = 0;
      }
      prev = collected.size;
    }
    log(`  Keyword Magic «${seed}» [${database}]: ${collected.size} ключей${limits ? ` · UI: осталось ${limits.remaining_updates}/${limits.max_updates}` : ''}.`);
    return { keywords: [...collected.values()].slice(0, limit), limits };
  } finally {
    page.off('response', onResp);
  }
}
