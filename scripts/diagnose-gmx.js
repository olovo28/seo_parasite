// Диагностика входа в почту gmx.at + структуры почтового ящика через Dolphin.
// Цель: закрепить (1) стабильный входной URL, (2) селекторы списка писем/тела внутри фрейма
// webmailer.gmx.net, (3) поведение consent/reCAPTCHA. Сохраняет HTML/скриншоты в diagnostics/.
//
//   npm run diagnose-gmx -- --email <id>
//   (ЖИВОЙ прогон: нужен открытый Dolphin{anty} и прокси у почты. Запускает пользователь.)

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { getDb } from '../db/db.js';
import { parseProxy } from '../lib/accounts.js';
import { launchProfileWithProxy, cleanupProfile, restoreCookies, captureCookies } from '../lib/browser.js';
import { getEmailAccountById, freeEmailAccounts, saveEmailCookies } from '../lib/emailAccounts.js';
import { getMailProvider } from '../lib/mail/index.js';
import { getSolver } from '../lib/captcha/index.js';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const db = getDb();
const emailId = Number(arg('--email', 0));
const acc = emailId ? getEmailAccountById(db, emailId) : freeEmailAccounts(db)[0];
if (!acc) throw new Error('Нет почты для диагностики (укажи --email <id> или добавь почту с прокси).');
if (!acc.proxy) throw new Error('У почты не задана прокси.');
const proxy = parseProxy(acc.proxy);
const provider = getMailProvider(acc.provider);
const solver = getSolver(db);

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const dir = `diagnostics/gmx-${ts}`;
mkdirSync(dir, { recursive: true });
const t0 = Date.now();
const log = (m) => {
  const line = `+${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`;
  console.log(line);
  appendFileSync(`${dir}/00-log.txt`, line + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log(`Почта #${acc.id} ${acc.email}, провайдер ${acc.provider}, прокси ${proxy.host}:${proxy.port}, cookies ${acc.cookies?.length || 0}, solver ${solver ? 'есть' : 'нет'}.`);

let browser;
let profileId;
try {
  const launched = await launchProfileWithProxy({ proxy });
  browser = launched.browser;
  profileId = launched.profileId;
  const page = launched.page;

  // Вход: сперва по cookie-сессии, иначе логин.
  let logged = false;
  if (Array.isArray(acc.cookies) && acc.cookies.length) {
    await restoreCookies(page, acc.cookies);
    logged = await provider.isLoggedIn(page).catch(() => false);
    log(`Восстановление cookies → залогинен: ${logged}`);
  }
  if (!logged) {
    try {
      await provider.login(page, { email: acc.email, password: acc.password, solver, proxy, log });
      logged = true;
      try {
        saveEmailCookies(db, acc.id, await captureCookies(page));
        log('Сессия почты сохранена.');
      } catch {}
    } catch (e) {
      log(`Логин не удался: ${e.message}`);
    }
  }

  writeFileSync(`${dir}/01-after-login.html`, await page.content());
  await page.screenshot({ path: `${dir}/01-after-login.png`, fullPage: true }).catch(() => {});
  log(`URL после входа: ${page.url()}`);

  // Перечень фреймов (ищем webmailer).
  log('Фреймы страницы:');
  for (const f of page.frames()) log(`  name="${(f.name() || '').slice(0, 40)}" url=${(f.url() || '').slice(0, 100)}`);

  // Зонд по ВСЕМ фреймам: поля ввода + элементы-триггеры логина (текст login/anmelden/einloggen).
  const probe = [];
  for (const f of page.frames()) {
    const info = await f
      .evaluate(() => {
        const inputs = [...document.querySelectorAll('input')].map((i) => ({ type: i.type, name: i.name, id: i.id, ph: i.placeholder, dt: i.getAttribute('data-testid') }));
        const triggers = [...document.querySelectorAll('a, button, [role="button"], [class*="login" i], [id*="login" i]')]
          .map((e) => ({ tag: e.tagName, id: e.id, cls: (e.className || '').toString().slice(0, 40), dt: e.getAttribute('data-testid'), href: e.getAttribute('href'), txt: (e.textContent || '').trim().slice(0, 30) }))
          .filter((e) => /login|anmeld|einloggen|posteingang|e-mail login/i.test(`${e.txt} ${e.id} ${e.cls} ${e.dt} ${e.href}`))
          .slice(0, 25);
        return { inputs: inputs.slice(0, 30), triggers };
      })
      .catch(() => null);
    if (info && (info.inputs.length || info.triggers.length)) probe.push({ frame: (f.url() || '').slice(0, 80), ...info });
  }
  writeFileSync(`${dir}/03-probe.json`, JSON.stringify(probe, null, 2));
  log(`Зонд фреймов: ${probe.length} фреймов с полями/триггерами (см. 03-probe.json).`);
  for (const p of probe) {
    log(`  [${p.frame}] inputs=${p.inputs.length} triggers=${p.triggers.length}`);
    for (const t of p.triggers.slice(0, 6)) log(`     trigger: ${t.tag} id=${t.id} dt=${t.dt} href=${(t.href || '').slice(0, 50)} «${t.txt}»`);
    for (const i of p.inputs.filter((x) => /email|password|user|text/i.test(x.type)).slice(0, 6)) log(`     input: type=${i.type} name=${i.name} id=${i.id} dt=${i.dt} ph=«${i.ph}»`);
  }

  // Пытаемся открыть ящик и снять структуру списка писем из фрейма.
  try {
    const frame = await provider.openInbox(page, { log });
    await sleep(3000);
    const html = await frame.content().catch(() => '');
    writeFileSync(`${dir}/02-inbox-frame.html`, html);
    await page.screenshot({ path: `${dir}/02-inbox.png`, fullPage: true }).catch(() => {});
    // Webmailer на Stencil — письма в shadow DOM. Обходим shadowRoots рекурсивно и собираем
    // элементы, похожие на строки писем (есть текст + кликабельны), дампим теги/классы/текст.
    const shadow = await frame
      .evaluate(() => {
        const out = [];
        const tags = new Set();
        const walk = (root, depth) => {
          if (depth > 12) return;
          const els = root.querySelectorAll('*');
          for (const el of els) {
            const tag = el.tagName.toLowerCase();
            if (/mail-list-item|maillistitem|list-item|mail-item|message/.test(tag)) {
              tags.add(tag);
              if (out.length < 8) out.push({ tag, cls: (el.className || '').toString().slice(0, 60), id: el.id, dt: el.getAttribute('data-testid'), txt: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100) });
            }
            if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
          }
        };
        walk(document, 0);
        return { itemTags: [...tags], samples: out };
      })
      .catch((e) => ({ error: e.message }));
    writeFileSync(`${dir}/04-shadow.json`, JSON.stringify(shadow, null, 2));
    log(`Shadow-DOM письма: теги=${JSON.stringify(shadow.itemTags || shadow.error)}; примеров=${(shadow.samples || []).length}`);
    for (const s of (shadow.samples || []).slice(0, 5)) log(`   item <${s.tag}> dt=${s.dt} «${s.txt}»`);
  } catch (e) {
    log(`Открыть ящик не удалось: ${e.message}`);
  }
} catch (e) {
  log(`ОШИБКА: ${e.message}`);
} finally {
  await cleanupProfile(browser, profileId);
  log(`Готово. Артефакты: ${dir}`);
}
process.exit(0);
