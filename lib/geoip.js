// Геолокация IP — для подбора региона регистрации под exit-IP прокси (чтобы профиль «жил» там, откуда заходит).
// Бесплатный ip-api.com (без ключа, HTTP). Запрос по УЖЕ известному exit-IP (IP — просто данные, прокси не нужна).
// На ошибку/таймаут возвращает null — вызывающий сам решает фолбэк (оставить регион случайным).

const GEO_BASE = process.env.GEOIP_URL || 'http://ip-api.com/json';

// Вернуть { countryCode, regionName, city, country } или null.
export async function geolocateIp(ip, { timeoutMs = 8000 } = {}) {
  if (!ip) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${GEO_BASE}/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city`, { signal: ctrl.signal });
    const j = await r.json();
    if (j.status !== 'success') return null;
    return { countryCode: j.countryCode, regionName: j.regionName, city: j.city, country: j.country };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
