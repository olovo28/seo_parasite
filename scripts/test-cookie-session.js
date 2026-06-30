// ЭКСПЕРИМЕНТ: переживает ли сессия сайта перезапуск одноразового профиля через сохранённые cookies?
// Профиль#1: логин → снять все cookies. Удалить профиль#1. Профиль#2 (та же прокси): инжектить cookies →
// открыть страницу только-для-залогиненных → проверить, не перебросило ли на /login.
//
// Запуск на ХОСТЕ (Dolphin{anty} открыт):
//   node --env-file=.env scripts/test-cookie-session.js [--site 1]

import { getDb } from '../db/db.js';
import { resolvePublishAccount, parseProxy, saveAccountCookies } from '../lib/accounts.js';
import { launchProfileWithProxy, cleanupProfile, captureCookies, restoreCookies } from '../lib/browser.js';
import { getAdapter } from '../lib/sites/index.js';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const t0 = Date.now();
const log = (m) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);

const SITE_ID = Number(arg('--site', '1'));
const db = getDb();
const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(SITE_ID);
if (!site) throw new Error(`Сайт ${SITE_ID} не найден.`);
const acc = resolvePublishAccount(db, SITE_ID);
const proxy = acc.proxy ? parseProxy(acc.proxy) : null;
if (!proxy) throw new Error('У аккаунта нет прокси — эксперимент требует прокси (как в бою).');
const adapter = getAdapter(site.adapter);

// --- Шаг 1: логин в профиле #1, снять cookies (хелпер browser.js) и СОХРАНИТЬ В БД (как в бою) ---
{
  log('Профиль #1: поднимаю с прокси…');
  const { browser, page, profileId } = await launchProfileWithProxy({ proxy });
  try {
    log(`Профиль #1 = ${profileId}. Логинюсь (с «angemeldet bleiben»)…`);
    await adapter.login(page, { origin: site.origin, username: acc.username, password: acc.password, log: (m) => log('  login: ' + m) });
    const cookies = await captureCookies(page);
    log(`Снято cookies: ${cookies.length}. Домены: ${[...new Set(cookies.map((c) => c.domain))].join(', ')}`);
    saveAccountCookies(db, acc.id, cookies);
    log(`Сохранил cookies в БД для аккаунта #${acc.id}.`);
  } finally {
    log('Профиль #1: закрываю и удаляю (как одноразовый).');
    await cleanupProfile(browser, profileId);
  }
}

// --- Шаг 2: свежий профиль #2, читаем cookies ИЗ БД, восстанавливаем, проверяем adapter.isLoggedIn ---
{
  const acc2 = resolvePublishAccount(db, SITE_ID); // перечитать с cookies из БД
  log(`Профиль #2: поднимаю свежий. Из БД прочитано cookies: ${acc2.cookies ? acc2.cookies.length : 0}`);
  const { browser, page, profileId } = await launchProfileWithProxy({ proxy });
  try {
    await restoreCookies(page, acc2.cookies);
    const ok = await adapter.isLoggedIn(page, { origin: site.origin });
    log(`adapter.isLoggedIn → ${ok} (URL: ${page.url()})`);
    if (ok) log('РЕЗУЛЬТАТ: интегрированный путь работает — сессия восстановлена из БД, логин пропускается.');
    else log('РЕЗУЛЬТАТ: перебросило на /login — cookies не сработали (сессия привязана к IP или истекла).');
  } finally {
    log('Профиль #2: закрываю и удаляю.');
    await cleanupProfile(browser, profileId);
  }
}
process.exit(0);
