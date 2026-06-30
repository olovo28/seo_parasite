// Реестр SMS-провайдеров (виртуальные номера для регистрации ящиков).
// Новый сервис = новый драйвер + строка в PROVIDERS. Контракт: rentNumber, getCode, finish, cancel, balance.

import { getSetting } from '../settings.js';
import { createFiveSim } from './fivesim.js';

const PROVIDERS = {
  fivesim: { label: '5sim.net', create: (key, opts) => createFiveSim({ apiKey: key, ...opts }) },
};

export function smsProviderList() {
  return Object.entries(PROVIDERS).map(([name, p]) => ({ name, label: p.label }));
}

// Провайдер из настроек (sms_provider + sms_api_key). null — если не сконфигурирован.
// country/product/operator — из env (дефолты austria/gmx/any), env приоритетнее БД.
export function getSmsProvider(db) {
  const provider = process.env.SMS_PROVIDER || (db && getSetting(db, 'sms_provider')) || '';
  const apiKey = process.env.SMS_API_KEY || (db && getSetting(db, 'sms_api_key')) || '';
  if (!provider || !apiKey) return null;
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Неизвестный SMS-сервис: ${provider}`);
  return p.create(apiKey, {
    country: process.env.SMS_COUNTRY || 'austria',
    product: process.env.SMS_PRODUCT || 'gmx',
    operator: process.env.SMS_OPERATOR || 'any',
  });
}
