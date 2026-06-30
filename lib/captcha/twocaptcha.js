// Драйвер сервиса 2captcha (и совместимых: rucaptcha и т.п. — задаётся baseUrl).
// Контракт: submit задачи → опрос результата. Используется в регистрации (графическая капча +
// при необходимости reCAPTCHA v2 на входе в почту).
//
//   solveImage(base64)            → строка-ответ (символы с картинки)
//   solveRecaptchaV2({siteKey,pageUrl}) → токен g-recaptcha-response

import { ProxyAgent } from 'undici';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch с ретраями при сетевых сбоях (нестабильный интернет/временная недоступность сервиса).
async function fetchRetry(url, opts, { tries = 4, delayMs = 3000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(delayMs);
    }
  }
  throw new Error(`сеть до капча-сервиса недоступна (${last?.message || 'fetch failed'})`);
}

export function createTwoCaptcha({ apiKey, baseUrl = 'https://2captcha.com', apiBase = 'https://api.2captcha.com', proxy, pollMs = 5000, timeoutMs = 180000 } = {}) {
  if (!apiKey) throw new Error('Не задан ключ сервиса капч (captcha_api_key).');
  // GMX/сеть могут блокировать прямой доступ к 2captcha → ходим через прокси аккаунта (если задан).
  let dispatcher;
  if (proxy?.host) {
    const cred = proxy.login ? `${encodeURIComponent(proxy.login)}:${encodeURIComponent(proxy.password || '')}@` : '';
    dispatcher = new ProxyAgent(`http://${cred}${proxy.host}:${proxy.port}`);
  }
  const withDisp = (opts = {}) => (dispatcher ? { ...opts, dispatcher } : opts);

  // Отправить задачу в in.php; возвращает id задачи.
  async function submit(params) {
    const body = new URLSearchParams({ key: apiKey, json: '1', ...params });
    const res = await fetchRetry(`${baseUrl}/in.php`, withDisp({ method: 'POST', body }));
    const j = await res.json().catch(() => ({}));
    if (j.status !== 1) throw new Error(`Капча-сервис отклонил задачу: ${j.request || res.status}`);
    return j.request;
  }

  // Опрашивать res.php, пока не готово (или таймаут).
  async function poll(id) {
    const deadline = Date.now() + timeoutMs;
    await sleep(pollMs);
    while (Date.now() < deadline) {
      const url = `${baseUrl}/res.php?key=${encodeURIComponent(apiKey)}&action=get&id=${encodeURIComponent(id)}&json=1`;
      const res = await fetchRetry(url, withDisp());
      const j = await res.json().catch(() => ({}));
      if (j.status === 1) return j.request;
      if (j.request && j.request !== 'CAPCHA_NOT_READY') throw new Error(`Капча-сервис: ${j.request}`);
      await sleep(pollMs);
    }
    throw new Error(`Капча-сервис: таймаут ожидания решения (${Math.round(timeoutMs / 1000)}с).`);
  }

  return {
    name: 'twocaptcha',
    // base64 — без префикса data:; если передали с префиксом, отрежем.
    async solveImage(base64) {
      const body = String(base64 || '').replace(/^data:image\/[a-z]+;base64,/i, '');
      if (!body) throw new Error('Пустая картинка капчи.');
      const id = await submit({ method: 'base64', body });
      return poll(id);
    },
    // dataS — параметр «data-s» reCAPTCHA на странице Google /sorry (без него решение не примут).
    async solveRecaptchaV2({ siteKey, pageUrl, dataS }) {
      if (!siteKey || !pageUrl) throw new Error('Для reCAPTCHA нужны siteKey и pageUrl.');
      const params = { method: 'userrecaptcha', googlekey: siteKey, pageurl: pageUrl };
      if (dataS) params['data-s'] = dataS;
      const id = await submit(params);
      return poll(id);
    },
    // CaptchaFox (GMX/WEB.DE вход) — через новый createTask API. Нужны прокси и userAgent (требование сервиса).
    async solveCaptchaFox({ siteKey, pageUrl, userAgent, proxy }) {
      if (!siteKey || !pageUrl) throw new Error('Для CaptchaFox нужны siteKey и pageUrl.');
      const task = { type: 'CaptchaFoxTask', websiteURL: pageUrl, websiteKey: siteKey, userAgent: userAgent || undefined };
      if (proxy?.host) {
        task.proxyType = proxy.type || 'http';
        task.proxyAddress = proxy.host;
        task.proxyPort = String(proxy.port);
        if (proxy.login) task.proxyLogin = proxy.login;
        if (proxy.password) task.proxyPassword = proxy.password;
      }
      const cr = await fetchRetry(`${apiBase}/createTask`, withDisp({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, task }),
      }));
      const cj = await cr.json().catch(() => ({}));
      if (cj.errorId || !cj.taskId) throw new Error(`CaptchaFox createTask: ${cj.errorDescription || cj.errorId || cr.status}`);
      const deadline = Date.now() + timeoutMs;
      await sleep(pollMs);
      while (Date.now() < deadline) {
        const rr = await fetchRetry(`${apiBase}/getTaskResult`, withDisp({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: apiKey, taskId: cj.taskId }),
        }));
        const rj = await rr.json().catch(() => ({}));
        if (rj.errorId) throw new Error(`CaptchaFox getTaskResult: ${rj.errorDescription || rj.errorId}`);
        if (rj.status === 'ready') return rj.solution?.token;
        await sleep(pollMs);
      }
      throw new Error(`CaptchaFox: таймаут ожидания решения (${Math.round(timeoutMs / 1000)}с).`);
    },
  };
}
