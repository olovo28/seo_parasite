// Человеческое поведение на сайте — для «прогрева» аккаунтов и правдоподобной регистрации: заходим, листаем
// 5–20 внутренних страниц со скроллом и случайными паузами, иногда возвращаемся назад. Всё через уже открытую
// puppeteer-страницу. Комментировать без входа нельзя (meinbezirk требует логин) → «человеческий фактор» здесь —
// чтение/скролл/переходы. Ничего не публикуем и не логинимся.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// Закрыть баннер согласия (OneTrust/CleverPush/generic «Akzeptieren») — site-agnostic, best-effort по всем фреймам.
export async function dismissConsent(page) {
  for (const frame of [page, ...page.frames()]) {
    await frame
      .evaluate(() => {
        const byId = document.querySelector('#onetrust-accept-btn-handler, .ot-pc-refuse-all-handler');
        if (byId) { byId.click(); return true; }
        const els = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')];
        const ok = els.find((e) => {
          const t = (e.textContent || e.value || '').trim().toLowerCase();
          if (!t || t.length > 40) return false;
          if (/abo|premium|kostenpflicht|einstellung|verwalt|mehr erfahren|details/.test(t)) return false;
          return /akzeptier|zustimmen|einverstanden|alle annehmen|accept all|accept|verstanden|ok/.test(t);
        });
        if (ok) { ok.click(); return true; }
        return false;
      })
      .catch(() => {});
  }
}

// Плавный «человеческий» скролл вниз на несколько экранов с паузами.
async function humanScroll(page, steps = rnd(3, 8)) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: 'smooth' }), rnd(300, 900)).catch(() => {});
    await sleep(rnd(500, 2500));
  }
}

// Собрать внутренние ссылки того же домена (кроме служебных: login/register/logout/редактор статьи).
async function collectLinks(page, host) {
  return page
    .evaluate((h) => {
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        try {
          const u = new URL(a.href, location.href);
          if (u.host === h && /^https?:/.test(u.protocol) && !/\/(login|register|logout|abmelden)/.test(u.pathname) && !/^\/a\//.test(u.pathname)) out.push(u.href);
        } catch { /* битый href */ }
      }
      return [...new Set(out)];
    }, host)
    .catch(() => []);
}

// Полистать сайт как человек. Возвращает число посещённых страниц.
export async function humanBrowse(page, { origin, minPages = 5, maxPages = 20, log = () => {}, shouldStop = () => false } = {}) {
  const host = new URL(origin).host;
  const target = rnd(minPages, maxPages);
  log(`Человеческий обзор: план ${target} страниц…`);
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await dismissConsent(page);
  await sleep(rnd(1500, 4000));
  await humanScroll(page);
  let visited = 1;
  let pool = await collectLinks(page, host);
  while (visited < target && !shouldStop()) {
    if (!pool.length) {
      pool = await collectLinks(page, host);
      if (!pool.length) break;
    }
    const url = pool.splice(rnd(0, pool.length - 1), 1)[0];
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      visited += 1;
      await sleep(rnd(2000, 6000)); // «читаем»
      await humanScroll(page, rnd(2, 6));
      if (Math.random() < 0.3) {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(rnd(1000, 3000));
      }
      if (Math.random() < 0.4) {
        const more = await collectLinks(page, host);
        if (more.length) pool.push(...more);
      }
    } catch { /* битая ссылка — идём дальше */ }
    await sleep(rnd(800, 3000));
  }
  log(`Обзор завершён: посещено ${visited} страниц.`);
  return visited;
}
