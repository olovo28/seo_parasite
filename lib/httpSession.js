// HTTP-транспорт к сайту БЕЗ запуска Dolphin: голые запросы через прокси аккаунта с его сохранёнными cookies.
// Доказано зондом: meinbezirk (PEIQ/Symfony) принимает кука-авторизацию от не-браузерного клиента, анти-бота нет.
// Используется для статистики (GET кокпита) и публикации/удаления (форма Symfony + CSRF-токен).

import { ProxyAgent } from 'undici';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Собрать заголовок Cookie из массива cookie-объектов (формат CDP: {name,value,domain,...}) для хоста.
export function cookieHeader(cookies, host) {
  if (typeof cookies === 'string') return cookies;
  if (!Array.isArray(cookies)) return '';
  return cookies
    .filter((c) => {
      const d = String(c.domain || '').replace(/^\./, '');
      return d && (host === d || host.endsWith('.' + d) || ('.' + host).endsWith('.' + d));
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

// Запрос к сайту через прокси аккаунта с куками. proxy — { host, port, login?, password? } (parseProxy).
// Возвращает { status, location, body }. redirect:'manual' — чтобы ловить редирект на /login (вылет сессии).
export async function proxyFetch(url, { proxy, cookies, origin, method = 'GET', headers = {}, body = null, redirect = 'manual', timeoutMs = 40000 } = {}) {
  if (!proxy?.host || !proxy?.port) throw new Error('proxyFetch: нет прокси.');
  const cred = proxy.login ? `${proxy.login}:${proxy.password}@` : '';
  const agent = new ProxyAgent(`http://${cred}${proxy.host}:${proxy.port}`);
  const host = new URL(origin).host;
  const h = { 'user-agent': BROWSER_UA, 'accept-language': 'de-DE,de;q=0.9', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...headers };
  if (cookies) h.cookie = cookieHeader(cookies, host);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { dispatcher: agent, method, headers: h, body, redirect, signal: ctrl.signal });
    const text = await r.text();
    const setCookie = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : [];
    return { status: r.status, location: r.headers.get('location'), body: text, setCookie };
  } finally {
    clearTimeout(t);
    agent.close().catch(() => {});
  }
}

// Применить Set-Cookie ответа к текущему заголовку Cookie (нужно для CSRF: GET формы обновляет сессионную куку,
// POST должен идти с ней же). currentHeader — строка "a=1; b=2"; setCookieArr — массив строк Set-Cookie.
export function mergeSetCookies(currentHeader, setCookieArr) {
  const map = new Map();
  for (const pair of String(currentHeader || '').split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const k = pair.slice(0, i).trim();
    if (k) map.set(k, pair.slice(i + 1).trim());
  }
  for (const sc of setCookieArr || []) {
    const first = String(sc).split(';')[0];
    const i = first.indexOf('=');
    if (i < 0) continue;
    const k = first.slice(0, i).trim();
    const v = first.slice(i + 1).trim();
    if (!k) continue;
    if (/expires=Thu, 01 Jan 1970|max-age=0/i.test(sc) || v === '' || v === 'deleted') map.delete(k);
    else map.set(k, v);
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Ответ — это переброс на логин (сессия истекла)?
export function isLoginResponse(r) {
  if (r.status >= 300 && r.status < 400 && /\/login/.test(r.location || '')) return true;
  return /id="username"|name="_username"|name="_csrf_token"/.test(r.body || '');
}
