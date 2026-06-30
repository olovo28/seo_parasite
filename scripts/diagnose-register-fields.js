// Инспекция полей формы регистрации (без сабмита): чекбоксы согласия, опции локации, радио.
//   node scripts/diagnose-register-fields.js --site 2 --email 21
import { getDb } from '../db/db.js';
import { parseProxy } from '../lib/accounts.js';
import { getEmailAccountById } from '../lib/emailAccounts.js';
import { launchProfileWithProxy, cleanupProfile } from '../lib/browser.js';
import { getAdapter } from '../lib/sites/index.js';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const db = getDb();
const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(arg('--site', 2)));
const emailAcc = getEmailAccountById(db, Number(arg('--email', 21)));
const proxy = parseProxy(emailAcc.proxy);
const adapter = getAdapter(site.adapter);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
let profileId;
try {
  const launched = await launchProfileWithProxy({ proxy });
  browser = launched.browser;
  profileId = launched.profileId;
  const page = launched.page;
  await page.goto(`${site.origin}/register`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (adapter.dismissBanners) await adapter.dismissBanners(page).catch(() => {});
  await sleep(3000);
  if (adapter.dismissBanners) await adapter.dismissBanners(page).catch(() => {});
  const info = await page.evaluate(() => {
    const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')].map((c) => ({ id: c.id, name: c.name, required: c.required, checked: c.checked }));
    const loc = document.querySelector('#register_location');
    const locOptions = loc ? [...loc.options].slice(0, 12).map((o) => ({ value: o.value, text: (o.textContent || '').trim().slice(0, 30) })) : null;
    const radios = [...document.querySelectorAll('input[type="radio"]')].map((r) => ({ id: r.id, name: r.name, value: r.value }));
    return { checkboxes, locOptions, locCount: loc ? loc.options.length : 0, radios };
  });
  console.log('CHECKBOXES:'); console.log(JSON.stringify(info.checkboxes, null, 1));
  console.log(`LOCATION select: ${info.locCount} опций, первые:`); console.log(JSON.stringify(info.locOptions, null, 1));
  console.log('RADIOS:'); console.log(JSON.stringify(info.radios, null, 1));
} finally {
  await cleanupProfile(browser, profileId);
}
