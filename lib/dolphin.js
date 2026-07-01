// Помощники для Dolphin{anty}: Remote API (CRUD профилей) + Local API (старт/стоп) + puppeteer.

import puppeteer from 'puppeteer-core';
import { lookup } from 'node:dns/promises';

const REMOTE_API = 'https://dolphin-anty-api.com';
// Хост, где запущен Dolphin{anty}. В Docker Dolphin на хосте → DOLPHIN_HOST=host.docker.internal.
const DOLPHIN_HOST = process.env.DOLPHIN_HOST || '127.0.0.1';
const LOCAL_API = process.env.DOLPHIN_LOCAL_API || `http://${DOLPHIN_HOST}:3001/v1.0`;

function token() {
  const t = process.env.DOLPHIN_API_TOKEN;
  if (!t) throw new Error('Не задан DOLPHIN_API_TOKEN. Создай .env (см. .env.example).');
  return t;
}

function remoteHeaders() {
  return {
    Authorization: `Bearer ${token()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// fetch с таймаутом — чтобы зависший Dolphin/сеть не вешали публикацию навсегда.
async function fetchT(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// --- Remote API -------------------------------------------------------------

// Вернуть объект профиля по имени или null.
export async function findProfile(name) {
  const res = await fetchT(`${REMOTE_API}/browser_profiles?page=1&limit=100`, { headers: remoteHeaders() });
  if (!res.ok) throw new Error(`Remote API list HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return (json.data ?? []).find((p) => p.name === name) ?? null;
}

// Список профилей (id, name) — для выбора профиля публикации в админке.
export async function listProfiles({ page = 1, limit = 100 } = {}) {
  const res = await fetchT(`${REMOTE_API}/browser_profiles?page=${page}&limit=${limit}`, { headers: remoteHeaders() });
  if (!res.ok) throw new Error(`Remote API list HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return (json.data ?? []).map((p) => ({ id: p.id, name: p.name }));
}

// Сгенерировать фингерпринт через Remote API (нужен, иначе профиль не стартует).
async function generateFingerprint() {
  const url =
    `${REMOTE_API}/fingerprints/fingerprint` +
    `?platform=windows&browser_type=anty&browser_version=125&type=fingerprint&screen=1920x1080`;
  const res = await fetchT(url, { headers: remoteHeaders() });
  if (!res.ok) throw new Error(`Fingerprint HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Создать профиль с полноценным фингерпринтом. proxy: {type,host,port,login,password}.
export async function createProfile({ name, proxy }) {
  const fp = await generateFingerprint();
  const body = {
    name,
    platform: 'windows',
    browserType: 'anty',
    mainWebsite: 'none',
    useragent: { mode: 'manual', value: fp.userAgent },
    webrtc: { mode: 'altered' },
    // canvas/webgl/clientRect/mediaDevices: НЕ отдаём реальные значения хоста (иначе все профили с этой машины
    // имеют одинаковый отпечаток → склейка аккаунтов). noise = стабильный уникальный шум на КАЖДЫЙ профиль.
    canvas: { mode: 'noise' },
    webgl: { mode: 'noise' },
    webglInfo: { mode: 'manual', vendor: fp.webgl.unmaskedVendor, renderer: fp.webgl.unmaskedRenderer },
    clientRect: { mode: 'noise' },
    timezone: { mode: 'auto' },
    locale: { mode: 'auto' },
    geolocation: { mode: 'auto' },
    cpu: { mode: 'manual', value: fp.hardwareConcurrency },
    memory: { mode: 'manual', value: fp.deviceMemory },
    screen: { mode: 'manual', resolution: `${fp.screen.width}x${fp.screen.height}` },
    mediaDevices: { mode: 'manual', audioInputs: 1, videoInputs: 1, audioOutputs: 1 }, // маскируем реальные ID устройств хоста
    ports: { mode: 'protect' },
    doNotTrack: false,
  };
  if (proxy) body.proxy = proxy;

  const res = await fetchT(`${REMOTE_API}/browser_profiles`, {
    method: 'POST',
    headers: remoteHeaders(),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !(json.success || json.browserProfileId)) {
    throw new Error(`Создание профиля не удалось (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.data?.id ?? json.browserProfileId;
}

export async function deleteProfile(id) {
  const res = await fetchT(`${REMOTE_API}/browser_profiles/${id}?forceDelete=1`, {
    method: 'DELETE',
    headers: remoteHeaders(),
  });
  return res.ok;
}

// --- Local API (приложение Dolphin должно быть открыто) ----------------------

export async function startProfile(id, { retryIfRunning = true } = {}) {
  // DOLPHIN_HEADLESS=1 — старт без видимого окна (фингерпринт Dolphin спуфится так же; быстрее/серверно).
  const headless = process.env.DOLPHIN_HEADLESS === '1' ? '&headless=1' : '';
  const res = await fetchT(`${LOCAL_API}/browser_profiles/${id}/start?automation=1${headless}`, {}, 90000);
  const text = await res.text();

  // Профиль уже запущен — останавливаем и пробуем ещё раз.
  if (!res.ok && retryIfRunning && /already running|E_BROWSER_RUN_DUPLICATE/i.test(text)) {
    console.log(`Профиль ${id} уже запущен — перезапускаю.`);
    await stopProfile(id);
    await new Promise((r) => setTimeout(r, 1500));
    return startProfile(id, { retryIfRunning: false });
  }

  if (!res.ok) throw new Error(`Local API start HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  if (!json.success || !json.automation) {
    throw new Error(`Старт не удался: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.automation; // { port, wsEndpoint }
}

export async function stopProfile(id) {
  try {
    await fetchT(`${LOCAL_API}/browser_profiles/${id}/stop`, {}, 15000);
  } catch {
    // профиль мог не запуститься — игнорируем
  }
}

// Запущено ли приложение Dolphin{anty} (доступен ли Local API на :3001).
// Любой HTTP-ответ = запущено; ошибка соединения (приложение закрыто) = нет.
export async function isDolphinRunning() {
  try {
    await fetchT(LOCAL_API, {}, 3000);
    return true;
  } catch {
    return false;
  }
}

export async function connect(automation) {
  const { port, wsEndpoint } = automation;
  const path = wsEndpoint.startsWith('/') ? wsEndpoint : `/devtools/browser/${wsEndpoint}`;
  // CDP отклоняет ws-подключения, если Host не localhost/IP. Если Dolphin на другом хосте
  // (напр. host.docker.internal из контейнера) — резолвим имя в IP, иначе будет 403.
  let host = DOLPHIN_HOST;
  if (host !== 'localhost' && !/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    try {
      host = (await lookup(host)).address;
    } catch {
      // не удалось зарезолвить — пробуем как есть
    }
  }
  return puppeteer.connect({ browserWSEndpoint: `ws://${host}:${port}${path}`, defaultViewport: null });
}

// Проверить, что прокси рабочая: открываем сервис, отдающий IP. Возвращает IP или null.
export async function checkConnectivity(browser) {
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  try {
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const ip = await page.evaluate(() => {
      try {
        return JSON.parse(document.body.innerText).ip;
      } catch {
        return null;
      }
    });
    return ip;
  } catch {
    return null;
  }
}

// --- Высокоуровневая оркестрация --------------------------------------------

// Гарантировать наличие профиля и запустить его.
// Если профиля нет — создаём с прокси proxyBase; при нерабочей прокси инкрементируем порт
// (proxyBase.port .. proxyBase.port + maxPortTries - 1), пересоздавая профиль.
// Возвращает { browser, profileId, created }.
export async function ensureProfileAndLaunch({ name, proxyBase, maxPortTries = 7 }) {
  if (!(await isDolphinRunning())) {
    throw new Error('Dolphin{anty} не запущен (Local API недоступен на :3001). Открой приложение Dolphin на этом ПК и повтори.');
  }
  const existing = await findProfile(name);
  if (existing) {
    console.log(`Профиль "${name}" найден (id=${existing.id}). Запускаю...`);
    const automation = await startProfile(existing.id);
    const browser = await connect(automation);
    return { browser, profileId: existing.id, created: false };
  }

  console.log(`Профиль "${name}" не найден. Создаю с прокси и проверяю запуск...`);
  const startPort = proxyBase.port;
  const lastPort = startPort + maxPortTries - 1;

  for (let port = startPort; port <= lastPort; port++) {
    const proxy = { ...proxyBase, port };
    let id;
    try {
      id = await createProfile({ name, proxy });
      console.log(`  Порт ${port}: профиль создан (id=${id}), запускаю...`);
      const automation = await startProfile(id);
      const browser = await connect(automation);
      const ip = await checkConnectivity(browser);
      if (ip) {
        console.log(`  Порт ${port}: прокси работает (внешний IP ${ip}).`);
        return { browser, profileId: id, created: true, proxyPort: port };
      }
      console.log(`  Порт ${port}: прокси не отвечает, пробую следующий...`);
      browser.disconnect();
    } catch (e) {
      console.log(`  Порт ${port}: ошибка (${e.message}), пробую следующий...`);
    }
    // неудача на этом порту — останавливаем и удаляем профиль перед следующей попыткой
    if (id) {
      await stopProfile(id);
      await deleteProfile(id);
    }
  }

  throw new Error(
    `Не удалось запустить "${name}" с рабочей прокси (порты ${startPort}-${lastPort}). Проверь прокси.`,
  );
}
