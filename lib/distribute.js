// Ручная раскладка выделенных статей по диапазону дат с выбранным часовым поясом.
// Режимы: 'interval' — от старта каждые N минут (конец = предел); 'even' — равномерно по диапазону.

import { utcStamp, zonedToEpoch } from './time.js';

// Массив эпох-слотов.
// nowEpoch — если задан и старт окна уже в прошлом (окно «идёт»), эффективный старт
// подтягивается к следующей целой минуте от «сейчас». Иначе просроченные слоты стали бы
// сразу «созревшими», и планировщик опубликовал бы их залпом (а не по интервалу).
export function computeSlotEpochs({ startEpoch, endEpoch, mode, intervalMin, count, nowEpoch = null }) {
  let start = startEpoch;
  if (nowEpoch != null && start < nowEpoch) start = Math.ceil(nowEpoch / 60000) * 60000; // вверх до минуты
  if (start > endEpoch) return []; // окно уже закрылось — слотов нет
  const slots = [];
  if (mode === 'even') {
    if (count <= 1) return [start];
    const step = (endEpoch - start) / (count - 1);
    for (let i = 0; i < count; i++) slots.push(Math.round(start + i * step));
    return slots;
  }
  const stepMs = Math.max(1, Number(intervalMin) || 1) * 60000;
  for (let t = start; t <= endEpoch; t += stepMs) slots.push(t);
  return slots;
}

// Перетасовать массив (Fisher–Yates). Обычный код приложения — Math.random тут уместен.
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Раскидать аккаунты по статьям round-robin со СЛУЧАЙНЫМ порядком, строго в пределах сайта статьи.
// orderedRows: [{ id, site_id }]; accountIds: выбранные id аккаунтов. Возвращает [accId|null, ...] по порядку.
// Балансирует (разница в нагрузке аккаунтов ≤1 за цикл), но порядок в цикле случаен — без жёсткого паттерна.
export function roundRobinAccounts(db, orderedRows, accountIds) {
  const ids = (accountIds || []).map(Number).filter(Boolean);
  if (!ids.length) return orderedRows.map(() => null);
  const placeholders = ids.map(() => '?').join(',');
  const accs = db.prepare(`SELECT id, site_id FROM site_accounts WHERE enabled = 1 AND id IN (${placeholders})`).all(...ids);
  const bySite = {};
  for (const a of accs) (bySite[a.site_id] ||= []).push(a.id);
  const bags = {};
  const next = (siteId) => {
    const pool = bySite[siteId];
    if (!pool || !pool.length) return null;
    if (!bags[siteId] || !bags[siteId].length) bags[siteId] = shuffle(pool);
    return bags[siteId].shift();
  };
  return orderedRows.map((r) => next(r.site_id));
}

// Лёгкий «джиттер» времени: сдвигаем каждый слот вперёд в пределах его сегмента (до 60% до следующего),
// чтобы расписание не было идеально регулярным (естественнее против антифрода). Порядок сохраняется,
// окно не нарушается (клампим к endEpoch). Слишком тесные слоты (≤1 мин) не трогаем.
function jitterSlots(slots, endEpoch) {
  if (slots.length <= 1) return slots;
  return slots.map((t, i) => {
    const next = i + 1 < slots.length ? slots[i + 1] : endEpoch;
    const gap = next - t;
    if (gap <= 60000) return t;
    return Math.min(t + Math.floor(Math.random() * gap * 0.6), endEpoch);
  });
}

// Разложить статьи по id. accountIds (опц.) — раскидать публикацию по этим аккаунтам (round-robin+shuffle).
// Возвращает { assigned, skipped, total, withAccount }.
export function distributeArticles(db, { ids, startDate, startTime, endDate, endTime, mode, intervalMin, timeZone, accountIds = [] }) {
  const startEpoch = zonedToEpoch(startDate, startTime, timeZone);
  const endEpoch = zonedToEpoch(endDate, endTime, timeZone);
  if (!Number.isFinite(startEpoch) || !Number.isFinite(endEpoch)) throw new Error('Неверная дата/время.');
  if (endEpoch < startEpoch) throw new Error('Конец раньше начала.');

  const idList = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
  if (idList.length === 0) throw new Error('Не выбрано ни одной статьи.');

  // Порядок — по id (стабильно). Тащим и site_id — для назначения аккаунта в пределах сайта.
  const orderedRows = db
    .prepare(`SELECT id, site_id FROM articles WHERE id IN (${idList.map(() => '?').join(',')}) ORDER BY id`)
    .all(...idList);
  const ordered = orderedRows.map((r) => r.id);

  const slots = jitterSlots(
    computeSlotEpochs({ startEpoch, endEpoch, mode, intervalMin, count: ordered.length, nowEpoch: Date.now() }),
    endEpoch,
  );
  if (slots.length === 0) throw new Error('Окно уже закрылось — выбери диапазон, который ещё не прошёл.');
  const n = Math.min(ordered.length, slots.length);

  // Пред-назначаем account_id (если выбраны аккаунты) — публикация и планировщик его уважают.
  const accAssign = roundRobinAccounts(db, orderedRows.slice(0, n), accountIds);

  const updAcc = db.prepare("UPDATE articles SET status = 'scheduled', scheduled_at = ?, account_id = ? WHERE id = ?");
  const updTime = db.prepare("UPDATE articles SET status = 'scheduled', scheduled_at = ? WHERE id = ?");
  let withAccount = 0;
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const stamp = utcStamp(new Date(slots[i]));
      if (accAssign[i] != null) {
        updAcc.run(stamp, accAssign[i], ordered[i]);
        withAccount++;
      } else {
        updTime.run(stamp, ordered[i]);
      }
    }
  })();

  return { assigned: n, skipped: ordered.length - n, total: ordered.length, withAccount };
}
