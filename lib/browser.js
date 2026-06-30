// Общий слой браузера/профиля (site-agnostic): запуск Dolphin-профиля, прокси-гейт, чистый старт,
// одноразовые профили под аккаунт, очистка. Никакой сайт-специфики — её делают адаптеры (lib/sites/*).

import { mkdirSync } from 'node:fs';
import { ensureProfileAndLaunch, findProfile, listProfiles, stopProfile, deleteProfile } from './dolphin.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Сколько раз пробовать поднять одноразовый профиль при сбое прокси-гейта. Прокси — ротационный шлюз:
// каждое переподключение даёт новый exit-IP, поэтому повтор той же прокси обычно срабатывает.
const LAUNCH_TRIES = Number(process.env.PROFILE_LAUNCH_TRIES || 4);
// Возраст, после которого одноразовый профиль pub-* считаем осиротевшим (процесс упал между create и delete).
const ORPHAN_MAX_AGE_MS = Number(process.env.PROFILE_ORPHAN_MAX_AGE_MS || 30 * 60000);

// Лимит одновременно ЗАПУЩЕННЫХ профилей Dolphin в рамках процесса: чтобы heavy-дорожка планировщика
// (статистика/позиции) и основной тик (публикация/удаление) суммарно не перегружали Dolphin/хост.
const DOLPHIN_MAX_CONCURRENT = Number(process.env.DOLPHIN_MAX_CONCURRENT || 6);
function makeSemaphore(max) {
  let active = 0;
  const waiters = [];
  return {
    acquire() {
      if (active < max) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise((res) => waiters.push(res)); // слот передаст release(), active не растёт здесь
    },
    release() {
      if (waiters.length) waiters.shift()(); // передаём слот следующему (active без изменений)
      else active -= 1;
    },
  };
}
const profileSem = makeSemaphore(DOLPHIN_MAX_CONCURRENT);
const slotReleases = new WeakMap(); // browser -> функция освобождения слота (вызывается в cleanupProfile)
function onceRelease() {
  let done = false;
  return () => {
    if (!done) {
      done = true;
      profileSem.release();
    }
  };
}

// Скриншот текущей страницы в screenshots/ (для отладки ошибок).
export async function screenshotTo(page, file) {
  mkdirSync('screenshots', { recursive: true });
  await page.screenshot({ path: `screenshots/${file}` }).catch(() => {});
}

// Чистый старт: чистим куки/кэш, закрываем все вкладки кроме одной свежей.
// Возвращает рабочую вкладку — дальше работаем только с ней (Dolphin подменяет стартовую).
export async function cleanStart(browser) {
  const page = await browser.newPage();
  try {
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies').catch(() => {});
    await client.send('Network.clearBrowserCache').catch(() => {});
    await client.detach().catch(() => {});
  } catch {
    // CDP может быть недоступен на некоторых сборках — не критично
  }
  for (const p of await browser.pages()) {
    if (p !== page) await p.close().catch(() => {});
  }
  await page.bringToFront().catch(() => {});
  return page;
}

// Запустить существующий профиль «с чистого листа» с проверкой прокси.
// Прерывает, если прокси не настроена в профиле или не отвечает. { browser, page, ip, proxyHost }.
export async function launchProfileClean(profileName) {
  const profile = await findProfile(profileName);
  if (!profile) throw new Error(`Профиль "${profileName}" не найден.`);
  if (!profile.proxy?.host) {
    throw new Error(`У профиля "${profileName}" не настроена прокси — использование профиля без прокси запрещено.`);
  }

  await profileSem.acquire();
  let browser;
  try {
    ({ browser } = await ensureProfileAndLaunch({ name: profileName }));
    const page = await cleanStart(browser);

    let ip = null;
    try {
      await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 30000 });
      ip = await page.evaluate(() => {
        try {
          return JSON.parse(document.body.innerText).ip;
        } catch {
          return null;
        }
      });
    } catch {
      // ip останется null
    }
    if (!ip) throw new Error(`Прокси профиля "${profileName}" (${profile.proxy.host}) не отвечает — прерываю.`);

    slotReleases.set(browser, onceRelease()); // слот держим до cleanupProfile
    return { browser, page, ip, proxyHost: profile.proxy.host };
  } catch (e) {
    profileSem.release();
    if (browser) {
      try {
        browser.disconnect();
      } catch {
        // already gone
      }
    }
    throw e;
  }
}

// Поднять ОДНОРАЗОВЫЙ профиль с заданной прокси (для публикации/удаления с конкретного аккаунта).
// proxy: { type, host, port, login?, password? }. ensureProfileAndLaunch создаёт+запускает+проверяет внешний IP.
// Профиль нужно удалить после (см. cleanupProfile). { browser, page, profileId }.
export async function launchProfileWithProxy({ proxy }) {
  if (!proxy?.host || !proxy?.port) throw new Error('У аккаунта не задана прокси — запуск без прокси запрещён.');
  await profileSem.acquire(); // занять слот лимита одновременных профилей (держим до cleanupProfile)
  let browser;
  let profileId;
  try {
    const name = `pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ({ browser, profileId } = await ensureProfileAndLaunch({ name, proxyBase: proxy, maxPortTries: 1 }));
    const page = await cleanStart(browser);
    slotReleases.set(browser, onceRelease());
    return { browser, page, profileId };
  } catch (e) {
    // Сбой запуска/cleanStart — освобождаем слот и чистим профиль (иначе id потеряется и он зависнет).
    profileSem.release();
    if (browser) {
      try {
        browser.disconnect();
      } catch {
        // already gone
      }
    }
    if (profileId) {
      await stopProfile(profileId).catch(() => {});
      await deleteProfile(profileId).catch(() => {});
    }
    throw e;
  }
}

// Удалить осиротевшие одноразовые профили pub-* (процесс упал между create и delete). Вызывать на старте
// web/scheduler. Удаляем только достаточно старые (по timestamp в имени), чтобы не задеть активную операцию.
export async function sweepOrphanProfiles({ olderThanMs = ORPHAN_MAX_AGE_MS, log = console.log } = {}) {
  let profiles;
  try {
    profiles = await listProfiles({ limit: 100 });
  } catch (e) {
    log(`Sweep профилей: список недоступен (${e.message}) — пропуск.`);
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const p of profiles) {
    const m = /^pub-(\d+)-/.exec(p.name || '');
    if (!m) continue;
    if (now - Number(m[1]) < olderThanMs) continue; // свежий — возможно, идёт операция
    try {
      await stopProfile(p.id);
      await deleteProfile(p.id);
      removed += 1;
      log(`Sweep: удалён осиротевший профиль ${p.name} (id=${p.id}).`);
    } catch (e) {
      log(`Sweep: не удалить ${p.name}: ${e.message}`);
    }
  }
  if (removed) log(`Sweep: удалено осиротевших профилей: ${removed}.`);
  return removed;
}

// Поднять профиль под аккаунт (с прокси → одноразовый; иначе — существующий профиль сайта).
// Возвращает { browser, page, ephemeralProfileId } (ephemeralProfileId != null только для одноразового).
export async function launchForAccount({ profileName, proxy, action, log = console.log, tries = LAUNCH_TRIES } = {}) {
  if (proxy) {
    // Ретрай: транзиентный сбой прокси-гейта (внешний IP не отдался) — частая причина «не удалось запустить».
    // Повторяем с той же прокси (ротационный шлюз → новый exit-IP), с короткой паузой.
    let last;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        log(`Создаю одноразовый профиль с прокси ${proxy.host}:${proxy.port}${attempt > 1 ? ` (попытка ${attempt}/${tries})` : ''}…`);
        const launched = await launchProfileWithProxy({ proxy });
        log(`Профиль ${launched.profileId} поднят${action ? ' (' + action + ')' : ''}, прокси проверена.`);
        return { browser: launched.browser, page: launched.page, ephemeralProfileId: launched.profileId };
      } catch (e) {
        last = e;
        log(`Профиль не поднялся: ${e.message}${attempt < tries ? ' — повтор…' : ''}`);
        if (attempt < tries) await sleep(2500);
      }
    }
    throw last;
  }
  log('Запускаю профиль сайта…');
  const launched = await launchProfileClean(profileName);
  log(`Прокси OK: ${launched.proxyHost}, внешний IP ${launched.ip}.`);
  return { browser: launched.browser, page: launched.page, ephemeralProfileId: null };
}

// Снять ВСЕ cookies браузера (для сохранения сессии сайта). Возвращает массив cookie-объектов.
export async function captureCookies(page) {
  const client = await page.target().createCDPSession();
  try {
    const { cookies } = await client.send('Network.getAllCookies');
    return cookies || [];
  } finally {
    await client.detach().catch(() => {});
  }
}

// Инжектить сохранённые cookies в браузер (до навигации) — восстановление сессии сайта.
// Устойчиво: один битый cookie (бывает при экспорте «всего браузера») не должен ронять весь набор.
export async function restoreCookies(page, cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return;
  const client = await page.target().createCDPSession();
  try {
    try {
      await client.send('Network.setCookies', { cookies });
    } catch {
      for (const c of cookies) await client.send('Network.setCookie', c).catch(() => {});
    }
  } finally {
    await client.detach().catch(() => {});
  }
}

// Закрыть/удалить одноразовый профиль (если KEEP_PROFILE=1 — оставить открытым для осмотра).
export async function cleanupProfile(browser, ephemeralProfileId) {
  const keepProfile = process.env.KEEP_PROFILE === '1';
  if (browser && !keepProfile) browser.disconnect();
  if (ephemeralProfileId) {
    if (keepProfile) console.log(`[KEEP_PROFILE=1] Одноразовый профиль ${ephemeralProfileId} ОСТАВЛЕН (не остановлен, не удалён). Удали вручную.`);
    else {
      await stopProfile(ephemeralProfileId).catch(() => {});
      await deleteProfile(ephemeralProfileId).catch(() => {});
    }
  }
  // Освободить слот лимита одновременных профилей (взят в launchProfileWithProxy/launchProfileClean).
  if (browser) {
    const rel = slotReleases.get(browser);
    if (rel) {
      slotReleases.delete(browser);
      rel();
    }
  }
}
