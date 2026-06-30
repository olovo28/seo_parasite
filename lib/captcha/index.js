// Реестр сервисов решения капч. Провайдер и ключ берутся из настроек (settings → env).
// Новый сервис = новый драйвер + строка в PROVIDERS (контракт: solveImage, solveRecaptchaV2).

import { getSetting } from '../settings.js';
import { createTwoCaptcha } from './twocaptcha.js';
import { createYesCaptcha } from './yescaptcha.js';

// Базовые URL совместимых с 2captcha API сервисов.
const PROVIDERS = {
  twocaptcha: { label: '2Captcha', create: (key, proxy) => createTwoCaptcha({ apiKey: key, proxy }) },
  rucaptcha: { label: 'RuCaptcha', create: (key, proxy) => createTwoCaptcha({ apiKey: key, baseUrl: 'https://rucaptcha.com', proxy }) },
  yescaptcha: { label: 'YesCaptcha', create: (key, proxy) => createYesCaptcha({ apiKey: key, proxy }) },
};

// Список провайдеров [{ name, label }] — для выбора в настройках.
export function captchaProviderList() {
  return Object.entries(PROVIDERS).map(([name, p]) => ({ name, label: p.label }));
}

// Решатель из настроек БД (captcha_provider + captcha_api_key). null — если не сконфигурирован
// (тогда регистрация с капчей упадёт с понятной ошибкой). env приоритетнее БД (applySettingsToEnv).
// proxy (опц.) — гнать запросы к сервису через прокси аккаунта (если сервис заблокирован напрямую).
// provider/apiKey (опц.) — явное переопределение (напр. отдельный решатель для SERP), иначе глобальные настройки.
export function getSolver(db, { proxy, provider: provOverride, apiKey: keyOverride } = {}) {
  const provider = provOverride || process.env.CAPTCHA_PROVIDER || (db && getSetting(db, 'captcha_provider')) || '';
  const apiKey = keyOverride || process.env.CAPTCHA_API_KEY || (db && getSetting(db, 'captcha_api_key')) || '';
  if (!provider || !apiKey) return null;
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Неизвестный сервис капч: ${provider}`);
  return p.create(apiKey, proxy);
}
