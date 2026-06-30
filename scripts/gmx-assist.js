// Ассистент РУЧНОЙ регистрации ящика GMX (человек в цикле).
// Я: создаю профиль Dolphin с прокси, открываю форму GMX, печатаю все данные для ввода и ЗАПИСЫВАЮ
// твои действия (поля/клики). Ты: вводишь данные, решаешь капчу, вводишь СВОЙ номер, получаешь SMS,
// завершаешь регистрацию. Потом жмёшь ENTER здесь — я сохраняю запись (для воспроизведения),
// cookies и сам аккаунт в пул email_accounts. Профиль НЕ удаляю.
//
//   npm run gmx-assist            (запускать в СВОЁМ терминале — нужен ручной ввод)
//   подсказка в чате: набери  ! npm run gmx-assist
//
// Требует: открытый Dolphin, импортированный прокси-пул (AT-1.txt).

import { mkdirSync, writeFileSync } from 'node:fs';
import { getDb } from '../db/db.js';
import { parseProxy } from '../lib/accounts.js';
import { assignProxy } from '../lib/proxyPool.js';
import { generateIdentity } from '../lib/identity.js';
import { ensureProfileAndLaunch, stopProfile } from '../lib/dolphin.js';
import { cleanStart, captureCookies } from '../lib/browser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = getDb();

const proxyUrl = assignProxy(db, { country: process.env.GMX_PROXY_COUNTRY || 'at' });
if (!proxyUrl) throw new Error('Нет прокси нужной страны в пуле (загрузи список прокси).');
const proxy = parseProxy(proxyUrl);
const id = generateIdentity();
const gMap = { female: 'weiblich', male: 'männlich', diverse: 'divers' };
const email = `${id.loginCandidates[0]}@${process.env.GMX_SIGNUP_DOMAIN || 'gmx.at'}`;
const altEmails = id.loginCandidates.slice(1, 4).map((c) => `${c}@gmx.at`);

const name = `gmx-assist-${Date.now().toString(36)}`;
console.log(`\nСоздаю профиль Dolphin «${name}» с прокси ${proxy.host}:${proxy.port}…`);
const { browser, profileId } = await ensureProfileAndLaunch({ name, proxyBase: proxy, maxPortTries: 1 });
const page = await cleanStart(browser);

// Рекордер действий: пишем change/click во window.__rec и в localStorage (переживает SPA-навигацию).
await page.evaluateOnNewDocument(() => {
  window.__rec = window.__rec || [];
  const log = (e) => {
    try {
      const t = e.target;
      if (!t || !t.tagName) return;
      window.__rec.push({ ts: Date.now(), ev: e.type, tag: t.tagName, id: t.id, name: t.name, dt: t.getAttribute && t.getAttribute('data-testid'), type: t.type, val: (t.value || '').slice(0, 100), txt: (t.textContent || '').trim().slice(0, 50) });
      try { localStorage.setItem('__rec', JSON.stringify(window.__rec.slice(-800))); } catch {}
    } catch {}
  };
  document.addEventListener('change', log, true);
  document.addEventListener('click', log, true);
});

const SIGNUP_URL = process.env.GMX_SIGNUP_URL || 'https://registrierung.gmx.net/?defaultCountry=AT';
await page.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
// гасим consent (Akzeptieren) best-effort
for (let i = 0; i < 3; i++) {
  for (const f of [page, ...page.frames()]) {
    await f.evaluate(() => {
      const b = [...document.querySelectorAll('button,a,[role="button"]')].find((x) => /akzeptier|zustimmen|einverstanden|alle annehmen/i.test((x.textContent || '').trim().toLowerCase()) && !/einstellung|ablehn/.test((x.textContent || '').toLowerCase()));
      if (b) b.click();
    }).catch(() => {});
  }
  await sleep(800);
}

console.log('\n==================== ДАННЫЕ ДЛЯ РЕГИСТРАЦИИ ====================');
console.log(`  Anrede/Geschlecht : ${gMap[id.gender]}`);
console.log(`  Vorname           : ${id.first_name}`);
console.log(`  Nachname          : ${id.last_name}`);
console.log(`  Geburtsdatum      : ${id.birth.day}.${id.birth.month}.${id.birth.year}`);
console.log(`  Land              : Österreich`);
console.log(`  PLZ / Ort         : ${id.address.plz} / ${id.address.city}`);
console.log(`  Straße & Nr.      : ${id.address.street}`);
console.log(`  Wunsch-E-Mail     : ${email}`);
console.log(`     (запасные      : ${altEmails.join(', ')})`);
console.log(`  Passwort          : ${id.password}`);
console.log(`  Telefon           : ВВЕДИ СВОЙ номер (поле уже с +43 → без кода и без нуля)`);
console.log('================================================================');
console.log(`\nПрофиль: ${name} (id ${profileId}), прокси ${proxy.host}:${proxy.port}.`);
console.log('Заполни форму этими данными, реши капчу, введи свой номер, получи SMS и заверши регистрацию.');
console.log('\nЖду завершения регистрации (до 25 минут). Определю успех автоматически и сохраню — нажимать ничего не нужно.\n');

// Ожидание БЕЗ stdin (работает в фоне): поллим состояние страницы, попутно копим запись действий.
// Успех = ушли с формы регистрации на ящик/навигатор GMX или текст «успешно/Willkommen».
let rec = [];
let done = false;
const deadline = Date.now() + 25 * 60 * 1000;
while (Date.now() < deadline) {
  await sleep(5000);
  try {
    const snap = await page.evaluate(() => window.__rec || JSON.parse(localStorage.getItem('__rec') || '[]'));
    if (Array.isArray(snap) && snap.length >= rec.length) rec = snap; // держим самый полный снимок
  } catch {
    // страница могла перейти на другой origin — запись уже скопили
  }
  let st = { url: '', ok: false };
  try {
    st = await page.evaluate(() => ({ url: location.href, ok: /erfolgreich|willkommen|gl[üu]ckwunsch|postfach eingerichtet|dein neues postfach/i.test(document.body?.innerText || '') }));
  } catch {}
  if (/navigator\.gmx|bap\.navigator|\/mail\b|account\.gmx/i.test(st.url) || st.ok) {
    console.log(`Похоже, регистрация завершена (${st.url || 'success-текст'}).`);
    done = true;
    break;
  }
}
if (!done) console.log('Таймаут ожидания — сохраняю то, что есть (если не успел — перезапусти).');

// Собираем запись действий + cookies.
const dir = `diagnostics/gmx-assist-${Date.now()}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/recording.json`, JSON.stringify(rec, null, 2));
try {
  writeFileSync(`${dir}/cookies.json`, JSON.stringify(await captureCookies(page), null, 2));
} catch {}

// Пытаемся определить реально введённый email (из записи) — иначе берём предложенный.
const typedEmail = (() => {
  for (const r of rec) {
    const v = (r.val || '').trim();
    if (/@/.test(v) && /gmx/i.test(v)) return v.toLowerCase();
  }
  // локальная часть, совпавшая с кандидатом
  for (const r of rec) {
    const v = (r.val || '').trim().toLowerCase();
    if (id.loginCandidates.includes(v)) return `${v}@gmx.at`;
  }
  return null;
})();
const finalEmail = typedEmail || email;

// Сохраняем аккаунт в пул (прокси закрепляется за ним). Телефон — из записи (10-13 цифр), если найдём.
const phone = (rec.map((r) => (r.val || '').replace(/\D/g, '')).find((d) => d.length >= 10 && d.length <= 13)) || null;
db.prepare("INSERT OR IGNORE INTO email_accounts (provider, email, password, proxy, phone, status) VALUES ('gmx', ?, ?, ?, ?, 'verified')")
  .run(finalEmail, id.password, proxyUrl, phone);

console.log(`\nСохранено: ящик ${finalEmail} → пул email_accounts (пароль ${id.password}).`);
console.log(`Запись действий: ${dir}/recording.json (${rec.length} событий), cookies: ${dir}/cookies.json`);
console.log('Профиль НЕ удалён (для воспроизведения). Останавливаю профиль…');
browser.disconnect();
await stopProfile(profileId).catch(() => {});
console.log('Готово.');
process.exit(0);
