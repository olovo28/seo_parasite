// Драйвер 5sim.net (приём SMS на виртуальные номера для регистрации ящиков).
// Auth — Bearer-токен. Поток: rentNumber → (вводим номер в форму) → getCode (поллинг) → finish/cancel.
// Для GMX: country='austria', product='gmx' (проверено — доступно на 5sim).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = 'https://5sim.net/v1';

export function createFiveSim({ apiKey, country = 'austria', operator = 'any', product = 'gmx', pollMs = 5000, timeoutMs = 300000 } = {}) {
  if (!apiKey) throw new Error('Не задан ключ SMS-сервиса (sms_api_key).');
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  async function get(path) {
    const r = await fetch(`${API}${path}`, { headers });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!r.ok) throw new Error(`5sim ${path}: HTTP ${r.status} ${text.slice(0, 120)}`);
    return json;
  }

  return {
    name: 'fivesim',
    async balance() {
      const j = await get('/user/profile');
      return j?.balance;
    },
    // Арендовать номер. Возвращает { id, phone } (phone в формате +43…).
    async rentNumber() {
      const j = await get(`/user/buy/activation/${country}/${operator}/${product}`);
      if (!j?.id || !j?.phone) throw new Error(`5sim: не удалось арендовать номер (${JSON.stringify(j).slice(0, 150)}).`);
      return { id: j.id, phone: j.phone };
    },
    // Дождаться кода из SMS (поллинг). Возвращает строку-код или throws по таймауту.
    async getCode(id, { timeout = timeoutMs } = {}) {
      const deadline = Date.now() + timeout;
      await sleep(pollMs);
      while (Date.now() < deadline) {
        const j = await get(`/user/check/${id}`);
        const sms = Array.isArray(j?.sms) ? j.sms : [];
        if (sms.length) {
          const last = sms[sms.length - 1];
          const code = last.code || (last.text || '').match(/\b(\d{4,8})\b/)?.[1];
          if (code) return String(code);
        }
        if (j?.status === 'CANCELED' || j?.status === 'BANNED' || j?.status === 'TIMEOUT') throw new Error(`5sim: заказ ${id} в статусе ${j.status}.`);
        await sleep(pollMs);
      }
      throw new Error(`5sim: код не пришёл за ${Math.round(timeout / 1000)}с (заказ ${id}).`);
    },
    // Завершить заказ успешно (после успешной регистрации).
    async finish(id) {
      await get(`/user/finish/${id}`).catch(() => {});
    },
    // Отменить заказ (если код не пришёл / регистрация не удалась) — возврат средств.
    async cancel(id) {
      await get(`/user/cancel/${id}`).catch(() => {});
    },
  };
}
