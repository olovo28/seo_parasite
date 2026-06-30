// Диагностика URL страницы регистрации сайта: пробуем кандидатов пути и проверяем наличие формы
// (#register_email). Ничего НЕ отправляем. Запуск профиля — с прокси указанной почты.
//
//   npm run diagnose-register -- --site 1 --email 1

import { getDb } from '../db/db.js';
import { parseProxy } from '../lib/accounts.js';
import { getEmailAccountById } from '../lib/emailAccounts.js';
import { launchProfileWithProxy, cleanupProfile } from '../lib/browser.js';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const db = getDb();
const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(arg('--site', 1)));
if (!site) throw new Error('Сайт не найден.');
const emailAcc = getEmailAccountById(db, Number(arg('--email', 1)));
if (!emailAcc?.proxy) throw new Error('У почты нет прокси.');
const proxy = parseProxy(emailAcc.proxy);

const CANDIDATES = ['/register', '/login/register', '/registrieren', '/registrierung', '/users/register', '/login', '/a/user/register', '/benutzer/registrieren'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
let profileId;
try {
  const launched = await launchProfileWithProxy({ proxy });
  browser = launched.browser;
  profileId = launched.profileId;
  const page = launched.page;
  for (const path of CANDIDATES) {
    const url = `${site.origin}${path}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);
      const info = await page.evaluate(() => ({
        finalUrl: location.href,
        hasEmail: !!document.querySelector('#register_email'),
        hasCaptcha: !!document.querySelector('#register_captcha, img.captcha_image'),
        hasName: !!document.querySelector('#register_name'),
        title: document.title.slice(0, 60),
      }));
      console.log(`${path} → ${info.finalUrl} | email=${info.hasEmail} captcha=${info.hasCaptcha} name=${info.hasName} | "${info.title}"`);
      if (info.hasEmail) {
        console.log(`>>> НАЙДЕНА форма регистрации по пути: ${path}`);
        break;
      }
    } catch (e) {
      console.log(`${path} → ошибка: ${e.message}`);
    }
  }
} finally {
  await cleanupProfile(browser, profileId);
}
process.exit(0);
