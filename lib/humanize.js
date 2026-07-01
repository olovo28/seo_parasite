// Человеческое поведение на сайте — для «прогрева» аккаунтов и правдоподобной регистрации: заходим, листаем
// 5–20 внутренних страниц со скроллом и случайными паузами, иногда возвращаемся назад. Всё через уже открытую
// puppeteer-страницу. Комментировать без входа нельзя (meinbezirk требует логин) → «человеческий фактор» здесь —
// чтение/скролл/переходы. Ничего не публикуем и не логинимся.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// Разрешить сайту уведомления/гео на уровне браузера — чтобы НАТИВНЫЙ запрос «разрешить уведомления?» авто-принимался
// (не висел). Больше «доверия»: реальный пользователь обычно разрешает. Best-effort.
export async function grantSitePermissions(page, origin) {
  try {
    const ctx = page.browserContext ? page.browserContext() : page.browser().defaultBrowserContext();
    await ctx.overridePermissions(origin, ['notifications', 'geolocation']);
  } catch { /* не критично */ }
}

// ПРИНЯТЬ всплывающие окна (куки OneTrust/Sourcepoint/Usercentrics + пуш CleverPush + generic) — site-agnostic, по всем
// фреймам, несколько попыток (баннеры всплывают с задержкой). Именно ПРИНИМАЕМ (не прячем/не отклоняем) — для доверия.
export async function acceptOverlays(page, tries = 3) {
  for (let i = 0; i < tries; i++) {
    let clicked = false;
    for (const frame of [page, ...page.frames()]) {
      const did = await frame
        .evaluate(() => {
          let hit = false;
          for (const sel of ['#onetrust-accept-btn-handler', '.cleverpush-confirm-btn-yes', '.cleverpush-confirmalert-button-yes', '[data-testid="uc-accept-all-button"]', 'button[title="Accept all"]', 'button[aria-label="Accept all"]']) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) { el.click(); hit = true; }
          }
          const want = /akzeptier|zustimmen|einverstanden|alle annehmen|alle akzeptieren|accept all|^accept$|^ok$|verstanden|erlauben|zulassen|benachrichtigungen erlauben|^ja\b/i;
          const avoid = /abo|premium|kostenpflicht|fremdwerbung|einstellung|verwalt|ablehn|reject|nur notwendig|mehr erfahren|details|sp[äa]ter|nicht (jetzt|erlauben)|zur[üu]ck/i;
          for (const e of document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]')) {
            const t = (e.textContent || e.value || '').trim();
            if (!t || t.length > 45) continue;
            if (avoid.test(t)) continue;
            if (want.test(t) && e.offsetParent !== null) { e.click(); hit = true; }
          }
          return hit;
        })
        .catch(() => false);
      if (did) clicked = true;
    }
    if (!clicked && i > 0) break; // ничего нового не нашли
    await sleep(700);
  }
}

// Реально ПОДПИСАТЬСЯ на пуш-уведомления сайта (CleverPush) — сильный сигнал доверия. Разрешение уже выдано
// (grantSitePermissions), opt-in кликнут (acceptOverlays); здесь дожимаем SDK-подписку и ждём push-subscription
// через Service Worker. Возвращает true, если появился реальный endpoint подписки. Best-effort.
export async function subscribePush(page, { log = () => {}, timeoutMs = 30000 } = {}) {
  try {
    // Разрешение выдано (grantSitePermissions) → CleverPush подписывается САМ при инициализации SDK. Нудж на всякий случай.
    await page
      .evaluate(() => {
        try { if (window.CleverPush && typeof window.CleverPush.subscribe === 'function') window.CleverPush.subscribe(); } catch { /* нет SDK-метода */ }
        try { if (Array.isArray(window._cleverPush)) window._cleverPush.push(['subscribe']); } catch { /* нет очереди */ }
        const bell = document.querySelector('.cleverpush-bell, [class*="cleverpush"][class*="bell"]');
        if (bell && bell.offsetParent !== null) bell.click();
      })
      .catch(() => {});
    const deadline = Date.now() + timeoutMs; // FCM-регистрация через прокси может занять >15с
    while (Date.now() < deadline) {
      const endpoint = await page
        .evaluate(async () => {
          try {
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const r of regs) {
              const s = await r.pushManager.getSubscription();
              if (s && s.endpoint) return s.endpoint;
            }
          } catch { /* нет SW/подписки */ }
          return null;
        })
        .catch(() => null);
      if (endpoint) {
        log(`Подписка на пуш оформлена (${String(endpoint).slice(0, 45)}…).`);
        return true;
      }
      await sleep(2000);
    }
    log('Пуш-подписка не подтвердилась за отведённое время (не критично).');
    return false;
  } catch {
    return false;
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
export async function humanBrowse(page, { origin, minPages = 5, maxPages = 20, entry = 'direct', pushSubscribe = false, log = () => {}, shouldStop = () => false } = {}) {
  const host = new URL(origin).host;
  const target = rnd(minPages, maxPages);
  // entry='google' → первый заход с Referer гугла (сайт видит органический источник); внутренние переходы обычные.
  const referer = entry === 'google' ? (Math.random() < 0.5 ? 'https://www.google.com/' : 'https://www.google.at/') : undefined;
  log(`Человеческий обзор: план ${target} страниц${referer ? ', заход как из Google' : ' (прямой заход)'}…`);
  await grantSitePermissions(page, origin); // разрешаем уведомления/гео (нативный запрос не висит)
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60000, referer }).catch(() => {});
  await acceptOverlays(page); // принимаем куки/пуш
  await sleep(rnd(1500, 4000));
  await acceptOverlays(page); // баннеры всплывают с задержкой — ещё раз
  await humanScroll(page);
  if (pushSubscribe) await subscribePush(page, { log }); // реально подписаться на пуш (после того как SDK загрузился)
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
      await acceptOverlays(page, 1); // на каждой странице (быстро, 1 проход)
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
