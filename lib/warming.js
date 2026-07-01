// «Прогрев» аккаунта перед регистрацией: несколько дней человеческих визитов на сайт с переиспользованием кук
// (returning visitor), чтобы к моменту регистрации сайт видел «частого посетителя». Один визит = один одноразовый
// профиль Dolphin с прокси почты → восстановить прошлые куки → humanBrowse (5–20 стр.) → сохранить куки.
// Профили не плодятся «навсегда»: каждый визит — новый эфемерный профиль, но с ТЕМИ ЖЕ куками (сессия переносится).

import { launchProfileWithProxy, cleanupProfile, captureCookies, restoreCookies } from './browser.js';
import { parseProxy } from './accounts.js';
import { getEmailAccountById } from './emailAccounts.js';
import { createRegistration, getRegistration, updateRegistration } from './registrations.js';
import { getAdapter } from './sites/index.js';
import { humanBrowse } from './humanize.js';
import { logRegEvent } from './regEvents.js';
import { getFarmConfig } from './farmConfig.js';
import { utcStamp } from './time.js';

// Нерегулярное следующее время визита: сейчас + случайно warm_min..warm_max ч (≈раз в сутки, но со сдвигом).
function nextWarmStamp(cfg) {
  const h = cfg.warm_min_hours + Math.random() * Math.max(0, cfg.warm_max_hours - cfg.warm_min_hours);
  return utcStamp(new Date(Date.now() + h * 3600000));
}

// Начать прогрев: создать регистрацию в статусе 'warming' (первый визит — сразу, next_warm_at=сейчас).
export function startWarming(db, { siteId, emailAccountId, identity, siteUsername, sitePassword, target } = {}) {
  const t = target || getFarmConfig(db).warm_target_visits;
  const rid = createRegistration(db, { siteId, emailAccountId, identity, siteUsername, sitePassword });
  updateRegistration(db, rid, { status: 'warming', warm_visits: 0, warm_target: t, next_warm_at: utcStamp(), error: null });
  logRegEvent(db, rid, 'warm_start', `Начат прогрев: цель ${t} визитов.`);
  return rid;
}

// Один визит прогрева. По достижении target → статус 'pending' (готов к регистрации; регистрацию запустит планировщик).
// Возвращает { ok, done, visits, target }.
export async function warmVisit(db, { registrationId, onStep } = {}) {
  const log = onStep || console.log;
  const reg = getRegistration(db, registrationId);
  if (!reg) throw new Error(`Регистрация #${registrationId} не найдена.`);
  const emailAcc = getEmailAccountById(db, reg.email_account_id);
  if (!emailAcc) throw new Error('Почта регистрации удалена.');
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(reg.site_id);
  if (!site) throw new Error(`Сайт ${reg.site_id} не найден.`);
  const proxy = emailAcc.proxy ? parseProxy(emailAcc.proxy) : null;
  if (!proxy) throw new Error('У почты нет прокси для прогрева.');
  const cfg = getFarmConfig(db);
  const target = reg.warm_target || cfg.warm_target_visits;

  let browser;
  let profileId = null;
  try {
    log(`Прогрев #${reg.id}: визит ${(reg.warm_visits || 0) + 1}/${target}, профиль с прокси ${proxy.host}:${proxy.port}…`);
    const launched = await launchProfileWithProxy({ proxy });
    browser = launched.browser;
    profileId = launched.profileId;
    const page = launched.page;

    // Восстановить сессию прошлых визитов (returning visitor) — до навигации.
    let prev = null;
    try {
      prev = reg.warm_cookies ? JSON.parse(reg.warm_cookies) : null;
    } catch { prev = null; }
    if (prev?.length) await restoreCookies(page, prev).catch(() => {});

    const visited = await humanBrowse(page, { origin: site.origin, minPages: cfg.warm_min_pages, maxPages: cfg.warm_max_pages, entry: cfg.warm_entry, pushSubscribe: cfg.push_subscribe, log });

    // Сохранить куки для следующего визита / для последующей регистрации.
    const fresh = await captureCookies(page).catch(() => null);
    const visits = (reg.warm_visits || 0) + 1;
    const done = visits >= target;
    updateRegistration(db, reg.id, {
      warm_visits: visits,
      warm_cookies: fresh && fresh.length ? JSON.stringify(fresh) : reg.warm_cookies,
      next_warm_at: done ? null : nextWarmStamp(cfg),
      status: done ? 'pending' : 'warming',
      error: null,
    });
    logRegEvent(db, reg.id, done ? 'warm_done' : 'warm_visit', `Визит ${visits}/${target}: посещено ${visited} стр.${done ? ' — прогрев завершён, к регистрации' : ''}`);
    log(`Прогрев #${reg.id}: визит ${visits}/${target}, страниц ${visited}${done ? ' — прогрев завершён, к регистрации' : ', следующий позже'}.`);
    return { ok: true, done, visits, target };
  } finally {
    await cleanupProfile(browser, profileId);
  }
}
