// Реестр почтовых провайдеров. Почта в email_accounts выбирает драйвер по полю provider.
// Новый провайдер = новый модуль lib/mail/<name>.js (с тем же интерфейсом) + строка в PROVIDERS.
// Интерфейс провайдера: { name, label, login, isLoggedIn, openInbox, findEmail }.

import gmx from './gmx.js';
import gmxde from './gmxde.js';
import gmxch from './gmxch.js';
import gmxnet from './gmxnet.js';
import webde from './webde.js';
import mailcom from './mailcom.js';
import outlook from './outlook.js';

const PROVIDERS = {
  gmx,
  gmxde,
  gmxch,
  gmxnet,
  webde,
  mailcom,
  outlook,
};

// Домен адреса → провайдер (для автоопределения при добавлении/импорте почт).
const DOMAIN_PROVIDER = {
  'gmx.at': 'gmx',
  'gmx.de': 'gmxde',
  'gmx.ch': 'gmxch',
  'gmx.net': 'gmxnet',
  'web.de': 'webde',
  'mail.com': 'mailcom',
};

// Домен → страна прокси (IMAP GMX требует IP «своей» страны: gmx.de→DE, gmx.ch→CH, gmx.at→AT).
const DOMAIN_COUNTRY = {
  'gmx.at': 'at',
  'gmx.de': 'de',
  'gmx.ch': 'ch',
  'gmx.net': 'de',
  'web.de': 'de',
};

// Определить провайдера по email (по домену); неизвестный домен → fallback.
export function providerForEmail(email, fallback = 'gmx') {
  const dom = String(email || '').split('@')[1]?.trim().toLowerCase();
  return (dom && DOMAIN_PROVIDER[dom]) || fallback;
}

// Страна прокси по email (по домену); неизвестный → fallback.
export function countryForEmail(email, fallback = 'at') {
  const dom = String(email || '').split('@')[1]?.trim().toLowerCase();
  return (dom && DOMAIN_COUNTRY[dom]) || fallback;
}

// Драйвер по имени (по умолчанию gmx). Бросает понятную ошибку для неизвестного.
export function getMailProvider(name) {
  const p = PROVIDERS[name || 'gmx'];
  if (!p) throw new Error(`Неизвестный почтовый провайдер: ${name}`);
  return p;
}

// Список провайдеров [{ name, label }] — для выбора в UI.
export function mailProviderList() {
  return Object.values(PROVIDERS).map((p) => ({ name: p.name, label: p.label || p.name }));
}
