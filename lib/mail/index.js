// Реестр почтовых провайдеров. Почта в email_accounts выбирает драйвер по полю provider.
// Новый провайдер = новый модуль lib/mail/<name>.js (с тем же интерфейсом) + строка в PROVIDERS.
// Интерфейс провайдера: { name, label, login, isLoggedIn, openInbox, findEmail }.

import gmx from './gmx.js';
import webde from './webde.js';
import mailcom from './mailcom.js';
import outlook from './outlook.js';

const PROVIDERS = {
  gmx,
  webde,
  mailcom,
  outlook,
};

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
