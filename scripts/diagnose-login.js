// Диагностика логина на сайт: поднимает профиль с прокси аккаунта и прогоняет РЕАЛЬНЫЙ логин адаптера,
// снимая скриншоты + HTML каждые ~1.5с (ловим «вылетающие плашки» по кадрам) + тайминги шагов.
// Артефакты — в diagnostics/login-<ts>/ (NN-frame.png / NN-frame.html / 00-log.txt).
//
// Запуск на ХОСТЕ (Dolphin{anty} открыт):
//   node --env-file=.env scripts/diagnose-login.js [--iterations N] [--site 1]

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { getDb } from '../db/db.js';
import { resolvePublishAccount, parseProxy } from '../lib/accounts.js';
import { launchProfileWithProxy, cleanupProfile } from '../lib/browser.js';
import { getAdapter } from '../lib/sites/index.js';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const SITE_ID = Number(arg('--site', '1'));
const ITERATIONS = Number(arg('--iterations', '1'));

async function runOnce(iter) {
  const db = getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(SITE_ID);
  if (!site) throw new Error(`Сайт ${SITE_ID} не найден.`);
  const acc = resolvePublishAccount(db, SITE_ID);
  const proxy = acc.proxy ? parseProxy(acc.proxy) : null;
  const adapter = getAdapter(site.adapter);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = `diagnostics/login-${ts}`;
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const log = (m) => {
    const line = `+${String((Date.now() - t0) / 1000).padStart(6, ' ')}s  ${m}`;
    console.log(line);
    appendFileSync(`${dir}/00-log.txt`, line + '\n');
  };
  log(`Итерация ${iter}. Сайт ${site.name} (${site.origin}), аккаунт ${acc.label}, прокси ${proxy ? proxy.host + ':' + proxy.port : 'нет'}.`);

  let browser;
  let page;
  let ephemeralProfileId = null;
  let seq = 0;
  let timer;
  const capture = async (label) => {
    const n = String(++seq).padStart(2, '0');
    try {
      await page.screenshot({ path: `${dir}/${n}-${label}.png` });
      const html = await page.content();
      writeFileSync(`${dir}/${n}-${label}.html`, html);
      // короткая сводка: какие баннеры/оверлеи присутствуют в DOM прямо сейчас
      const flags = await page.evaluate(() => ({
        onetrust: !!document.querySelector('#onetrust-banner-sdk'),
        cleverpush: !!document.querySelector('.cleverpush-confirm, .cleverpush-bell-prompt'),
        usercentrics: !!document.querySelector('#usercentrics-root, [id*="usercentrics"]'),
        modal: !!document.querySelector('.modal.show, [role="dialog"]'),
        loginForm: !!document.querySelector('#username'),
      }));
      log(`  [${n}] ${label} | ${page.url()} | ${Object.entries(flags).filter(([, v]) => v).map(([k]) => k).join(',') || 'без плашек'}`);
    } catch (e) {
      log(`  [${n}] ${label}: capture error ${e.message}`);
    }
  };

  try {
    log('Поднимаю профиль с прокси…');
    const launched = await launchProfileWithProxy({ proxy });
    browser = launched.browser;
    page = launched.page;
    ephemeralProfileId = launched.profileId;
    log(`Профиль ${ephemeralProfileId} поднят.`);

    // покадровая съёмка на всё время логина
    timer = setInterval(() => capture('frame').catch(() => {}), 1500);
    await capture('start');

    const tLogin = Date.now();
    await adapter.login(page, { origin: site.origin, username: acc.username, password: acc.password, log: (m) => log(`  login: ${m}`) });
    log(`Логин адаптера завершён за ${((Date.now() - tLogin) / 1000).toFixed(1)}с. URL: ${page.url()}`);

    clearInterval(timer);
    await capture('final');
  } catch (e) {
    if (timer) clearInterval(timer);
    log(`ОШИБКА: ${e.message}`);
    if (page) await capture('error');
  } finally {
    await cleanupProfile(browser, ephemeralProfileId);
    log(`Готово. Артефакты: ${dir}`);
  }
  return dir;
}

for (let i = 1; i <= ITERATIONS; i++) {
  // eslint-disable-next-line no-await-in-loop
  await runOnce(i).catch((e) => console.error('Итерация упала:', e.message));
}
process.exit(0);
