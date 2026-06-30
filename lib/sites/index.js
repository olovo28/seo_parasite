// Реестр адаптеров сайтов. Сайт в БД выбирает адаптер по полю sites.adapter (см. getAdapter).
// Добавить новый сайт = новый модуль lib/sites/<name>.js (с тем же интерфейсом) + строка в ADAPTERS.

import meinbezirk from './meinbezirk.js';
import meineKirchenzeitung from './meine-kirchenzeitung.js';
import meineNews from './meine-news.js';
import myheimat from './myheimat.js';

const ADAPTERS = {
  meinbezirk,
  'meine-kirchenzeitung': meineKirchenzeitung,
  'meine-news': meineNews,
  myheimat,
};

// Адаптер по имени (по умолчанию meinbezirk). Бросает понятную ошибку для неизвестного.
export function getAdapter(name) {
  const a = ADAPTERS[name || 'meinbezirk'];
  if (!a) throw new Error(`Неизвестный адаптер сайта: ${name}`);
  return a;
}

// Список доступных адаптеров [{ name, label }] — для выбора в настройках сайта.
export function adapterList() {
  return Object.values(ADAPTERS).map((a) => ({ name: a.name, label: a.label || a.name }));
}
