// Драйвер YesCaptcha (anti-captcha-совместимый API: createTask → getTaskResult).
// Контракт как у остальных решателей:
//   solveImage(base64)                        → строка-ответ (ImageToTextTask → solution.text)
//   solveRecaptchaV2({siteKey,pageUrl,dataS}) → токен (NoCaptchaTaskProxyless → solution.gRecaptchaResponse)
// dataS → recaptchaDataSValue (капча Google /sorry). proxy (опц.) — гнать запросы через прокси (если прямой доступ закрыт).

import { ProxyAgent } from 'undici';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  throw new Error(`сеть до YesCaptcha недоступна (${last?.message || 'fetch failed'})`);
}

export function createYesCaptcha({ apiKey, baseUrl = 'https://api.yescaptcha.com', proxy, pollMs = 5000, timeoutMs = 180000 } = {}) {
  if (!apiKey) throw new Error('Не задан ключ YesCaptcha.');
  let dispatcher;
  if (proxy?.host) {
    const cred = proxy.login ? `${encodeURIComponent(proxy.login)}:${encodeURIComponent(proxy.password || '')}@` : '';
    dispatcher = new ProxyAgent(`http://${cred}${proxy.host}:${proxy.port}`);
  }
  const withDisp = (opts = {}) => (dispatcher ? { ...opts, dispatcher } : opts);

  async function post(path, payload) {
    const res = await fetchRetry(`${baseUrl}${path}`, withDisp({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
    return res.json().catch(() => ({}));
  }

  async function solveTask(task) {
    const cr = await post('/createTask', { clientKey: apiKey, task });
    if (cr.errorId || !cr.taskId) throw new Error(`YesCaptcha createTask: ${cr.errorDescription || cr.errorCode || cr.errorId || 'нет taskId'}`);
    const deadline = Date.now() + timeoutMs;
    await sleep(pollMs);
    while (Date.now() < deadline) {
      const rr = await post('/getTaskResult', { clientKey: apiKey, taskId: cr.taskId });
      if (rr.errorId) throw new Error(`YesCaptcha: ${rr.errorDescription || rr.errorCode || rr.errorId}`);
      if (rr.status === 'ready') return rr.solution || {};
      await sleep(pollMs);
    }
    throw new Error(`YesCaptcha: таймаут ожидания решения (${Math.round(timeoutMs / 1000)}с).`);
  }

  return {
    name: 'yescaptcha',
    async getBalance() {
      const j = await post('/getBalance', { clientKey: apiKey });
      if (j.errorId) throw new Error(`YesCaptcha getBalance: ${j.errorDescription || j.errorId}`);
      return j.balance;
    },
    async solveImage(base64) {
      const body = String(base64 || '').replace(/^data:image\/[a-z]+;base64,/i, '');
      if (!body) throw new Error('Пустая картинка капчи.');
      const sol = await solveTask({ type: 'ImageToTextTask', body });
      return sol.text;
    },
    async solveRecaptchaV2({ siteKey, pageUrl, dataS }) {
      if (!siteKey || !pageUrl) throw new Error('Для reCAPTCHA нужны siteKey и pageUrl.');
      const task = { type: 'NoCaptchaTaskProxyless', websiteURL: pageUrl, websiteKey: siteKey };
      if (dataS) task.recaptchaDataSValue = dataS;
      const sol = await solveTask(task);
      return sol.gRecaptchaResponse;
    },
  };
}
