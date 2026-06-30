// Канон времени статей: ХРАНИМ в UTC, ПОКАЗЫВАЕМ и ЗАДАЁМ (окно сайта) в часовом поясе сайта.
// Намеренно НЕТ хелперов «локального времени машины»: результат не должен зависеть от того, где запущен
// код (хост=Екб, docker=UTC). Всё wall-clock считается через zonedToEpoch(...tz) → utcStamp.

const p = (n) => String(n).padStart(2, '0');

// ── Канон времени статей: ХРАНИМ в UTC, ПОКАЗЫВАЕМ в часовом поясе сайта. ──
// Не зависит от часового пояса процесса/контейнера (host=Екб, docker=UTC — было источником путаницы).

// Текущее (или заданное) время как UTC 'YYYY-MM-DD HH:MM:SS' (лексикографически сортируется/сравнивается).
export function utcStamp(d = new Date()) {
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// Эпоха (мс) из хранимой UTC-строки 'YYYY-MM-DD HH:MM[:SS]'. Пусто/мусор → null.
export function parseStamp(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : null;
}

// Показать хранимую UTC-строку в зоне tz как 'YYYY-MM-DD HH:MM' (или '-' если пусто).
export function fmtInTz(s, tz) {
  const ep = parseStamp(s);
  if (ep == null) return '-';
  const z = epochToZoned(ep, tz);
  return `${z.date} ${z.time}`;
}

// Основные часовые зоны Европы с пометкой смещения от Лондона (для выпадающего списка).
export const EU_TZ = [
  ['Europe/London', 'Лондон (0)'],
  ['Europe/Lisbon', 'Лиссабон (0)'],
  ['Europe/Vienna', 'Вена (+1)'],
  ['Europe/Berlin', 'Берлин (+1)'],
  ['Europe/Paris', 'Париж (+1)'],
  ['Europe/Madrid', 'Мадрид (+1)'],
  ['Europe/Rome', 'Рим (+1)'],
  ['Europe/Warsaw', 'Варшава (+1)'],
  ['Europe/Prague', 'Прага (+1)'],
  ['Europe/Amsterdam', 'Амстердам (+1)'],
  ['Europe/Athens', 'Афины (+2)'],
  ['Europe/Helsinki', 'Хельсинки (+2)'],
  ['Europe/Bucharest', 'Бухарест (+2)'],
  ['Europe/Kyiv', 'Киев (+2)'],
  ['Europe/Moscow', 'Москва (+3)'],
  ['Europe/Istanbul', 'Стамбул (+3)'],
];

// Смещение зоны (мс) в конкретный момент.
function tzOffsetMs(instant, timeZone) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
    .formatToParts(instant)
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - instant.getTime();
}

// Обратное к zonedToEpoch: эпоха (мс) → { date:'YYYY-MM-DD', time:'HH:MM' } в зоне timeZone.
export function epochToZoned(epoch, timeZone) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
    .formatToParts(new Date(epoch))
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}` };
}

// Эпоха ближайшего наступления времени hhmm ('HH:MM') в зоне tz, строго в будущем относительно fromEpoch.
// Используется для авто-удаления «к закрытию окна» (window_end сайта).
export function nextDailyOccurrence(hhmm, tz, fromEpoch = Date.now()) {
  const todayDate = epochToZoned(fromEpoch, tz).date;
  let ep = zonedToEpoch(todayDate, hhmm, tz);
  if (ep <= fromEpoch) {
    const tomorrowDate = epochToZoned(fromEpoch + 86400000, tz).date;
    ep = zonedToEpoch(tomorrowDate, hhmm, tz);
  }
  return ep;
}

// Эпоха (мс) для wall-clock 'YYYY-MM-DD' + 'HH:MM' в зоне timeZone (с учётом DST).
export function zonedToEpoch(dateStr, timeStr, timeZone) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const [h, mi] = String(timeStr || '00:00').split(':').map(Number);
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let off = tzOffsetMs(new Date(utcGuess), timeZone);
  off = tzOffsetMs(new Date(utcGuess - off), timeZone); // уточнение на границе перехода
  return utcGuess - off;
}
