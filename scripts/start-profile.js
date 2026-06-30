// Запуск профиля Dolphin{anty} "Profile 6", загрузка кук из "Quick 1.json"
// и открытие сайта https://meinbezirk.at внутри профиля.
//
// Запуск из корня проекта (приложение Dolphin{anty} должно быть открыто):
//   node --env-file=.env scripts/start-profile.js
//
// Что делает:
//   1) находит id профиля по имени через Remote API;
//   2) стартует профиль в режиме автоматизации через Local API (порт 3001);
//   3) подключается к браузеру через puppeteer-core;
//   4) ставит куки из reference/cookies/Quick 1.json и открывает meinbezirk.at.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REMOTE_API = 'https://dolphin-anty-api.com';
const LOCAL_API = 'http://localhost:3001/v1.0';
const PROFILE_NAME = 'Profile 6';
const COOKIES_FILE = join(__dirname, '..', 'reference', 'cookies', 'Quick 1.json');
const TARGET_URL = 'https://meinbezirk.at';

const token = process.env.DOLPHIN_API_TOKEN;
if (!token) {
  console.error('Не задан DOLPHIN_API_TOKEN. Создай .env (см. .env.example).');
  process.exit(1);
}

// --- 1. Найти id профиля по имени -------------------------------------------
async function findProfileId(name) {
  const res = await fetch(`${REMOTE_API}/browser_profiles?page=1&limit=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Remote API HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const profiles = json.data ?? json;
  const profile = profiles.find((p) => p.name === name);
  if (!profile) throw new Error(`Профиль "${name}" не найден.`);
  return profile.id;
}

// --- 2. Стартовать профиль через Local API ----------------------------------
async function startProfile(profileId) {
  const res = await fetch(`${LOCAL_API}/browser_profiles/${profileId}/start?automation=1`);
  if (!res.ok) throw new Error(`Local API HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (!json.success || !json.automation) {
    throw new Error(`Старт не удался: ${JSON.stringify(json)}`);
  }
  return json.automation; // { port, wsEndpoint }
}

// --- Преобразование кук Cookie-Editor -> формат CDP -------------------------
const SAME_SITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' };

function toCdpCookie(c) {
  const cookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  if (typeof c.expirationDate === 'number' && c.expirationDate > 0) {
    cookie.expires = c.expirationDate;
  }
  const ss = SAME_SITE[c.sameSite];
  // CDP требует secure=true при sameSite=None — иначе кука будет отклонена.
  if (ss && !(ss === 'None' && !cookie.secure)) {
    cookie.sameSite = ss;
  }
  return cookie;
}

async function loadCookies(page, file) {
  const raw = await readFile(file, 'utf8');
  const cookies = JSON.parse(raw).map(toCdpCookie);

  const client = await page.target().createCDPSession();
  await client.send('Network.enable');

  let ok = 0;
  const results = await Promise.allSettled(
    cookies.map((cookie) => client.send('Network.setCookie', cookie)),
  );
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value?.success !== false) ok++;
  }
  await client.detach();
  return { ok, total: cookies.length };
}

// --- main -------------------------------------------------------------------
async function main() {
  console.log(`Ищу профиль "${PROFILE_NAME}"...`);
  const profileId = await findProfileId(PROFILE_NAME);
  console.log(`Найден id=${profileId}. Стартую...`);

  const { port, wsEndpoint } = await startProfile(profileId);
  const path = wsEndpoint.startsWith('/') ? wsEndpoint : `/devtools/browser/${wsEndpoint}`;
  const browserWSEndpoint = `ws://127.0.0.1:${port}${path}`;
  console.log(`Профиль запущен. Подключаюсь: ${browserWSEndpoint}`);

  const browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null });

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());

  console.log(`Загружаю куки из "${COOKIES_FILE}"...`);
  const { ok, total } = await loadCookies(page, COOKIES_FILE);
  console.log(`Куки установлены: ${ok}/${total}`);

  console.log(`Открываю ${TARGET_URL}...`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('Готово. Сайт открыт. Браузер оставляю запущенным.');

  // Отключаемся, не закрывая браузер профиля.
  browser.disconnect();
}

main().catch((err) => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
