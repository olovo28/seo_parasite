// Диагностика SEMrush UI через Dolphin ПО COOKIE-СЕССИИ (без логина — его SEMrush блокирует).
// Ищем: (1) эндпоинт ключей Keyword Magic; (2) где отдаются UI-лимиты (limit/quota/remaining/reset).
//
//   docker compose exec -T web node scripts/diagnose-semrush.js --account 3 --seed Sportwetten --db de

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { getDb } from '../db/db.js';
import { resolveSemrushAccount } from '../lib/semrushAccounts.js';
import { parseProxy } from '../lib/accounts.js';
import { launchProfileWithProxy, cleanupProfile, restoreCookies } from '../lib/browser.js';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ACCID = arg('--account', null);
const SEED = arg('--seed', 'Sportwetten');
const DB = arg('--db', 'de');

const db = getDb();
const acc = resolveSemrushAccount(db, ACCID);
const proxy = acc.proxy ? parseProxy(acc.proxy) : null;
if (!proxy) throw new Error('У аккаунта нет прокси.');
if (!Array.isArray(acc.cookies) || !acc.cookies.length) throw new Error('У аккаунта нет cookies — вставь сессию.');

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const dir = `diagnostics/semrush-${ts}`;
mkdirSync(dir, { recursive: true });
const t0 = Date.now();
const log = (m) => {
  const line = `+${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`;
  console.log(line);
  appendFileSync(`${dir}/00-log.txt`, line + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log(`Аккаунт #${acc.id} «${acc.label || acc.email}», cookies ${acc.cookies.length}, прокси ${proxy.host}:${proxy.port}.`);
let browser;
let profileId;
try {
  const launched = await launchProfileWithProxy({ proxy });
  browser = launched.browser;
  profileId = launched.profileId;
  const page = launched.page;
  log(`Профиль ${profileId}. Восстанавливаю cookies…`);
  await restoreCookies(page, acc.cookies);

  const limits = [];
  const kwEp = [];
  page.on('response', async (res) => {
    try {
      const u = res.url();
      if (!/json/i.test(res.headers()['content-type'] || '')) return;
      const body = await res.text().catch(() => '');
      if (!body) return;
      if (/\/kmtgw\//.test(u) && /"keywords"/.test(body)) {
        // верхнеуровневые ключи ответа (вдруг лимит внутри)
        let keys = '';
        try {
          keys = Object.keys(JSON.parse(body).result || {}).join(',');
        } catch {}
        kwEp.push({ url: u.slice(0, 80), keys });
      }
      if (/limit|quota|remaining|"reset|left|usage|subscription|allowance|exceed/i.test(body) && body.length < 30000) {
        limits.push({ url: u.slice(0, 110), len: body.length, sample: body.replace(/\s+/g, ' ').slice(0, 500) });
      }
    } catch {
      // игнор
    }
  });

  const url = `https://www.semrush.com/analytics/keywordmagic/?q=${encodeURIComponent(SEED)}&db=${DB}`;
  log(`Открываю Keyword Magic: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(9000);
  writeFileSync(`${dir}/keywordmagic.html`, await page.content());
  log(`URL: ${page.url()} (на /login: ${page.url().includes('/login')})`);
  log(`kmtgw-ответы: ${JSON.stringify(kwEp.slice(0, 3))}`);
  log(`Лимит-подобные ответы (${limits.length}):`);
  for (const l of limits.slice(0, 8)) log(`  ${l.url} [${l.len}b] :: ${l.sample}`);

  // Пробуем известные страницы лимитов/профиля и ловим их XHR.
  for (const p of ['/users/subscription.html', '/billing-admin/api/', '/users/profile.html']) {
    try {
      await page.goto(`https://www.semrush.com${p}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      log(`Открыл ${p} → ${page.url()}`);
    } catch (e) {
      log(`${p}: ${e.message}`);
    }
  }
  log(`Лимит-подобные ответы ИТОГО (${limits.length}):`);
  for (const l of limits.slice(0, 12)) log(`  ${l.url} :: ${l.sample.slice(0, 220)}`);
} catch (e) {
  log(`ОШИБКА: ${e.message}`);
} finally {
  await cleanupProfile(browser, profileId);
  log(`Готово. Артефакты: ${dir}`);
}
process.exit(0);
