import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utcStamp, parseStamp, fmtInTz, zonedToEpoch } from '../lib/time.js';

test('utcStamp/parseStamp: формат UTC и обратный разбор', () => {
  const ep = Date.UTC(2026, 5, 21, 16, 35, 0);
  assert.equal(utcStamp(new Date(ep)), '2026-06-21 16:35:00');
  assert.equal(parseStamp('2026-06-21 16:35:00'), ep);
  assert.equal(parseStamp(''), null);
  assert.equal(parseStamp(null), null);
});

test('канон времени: ввод 19:35 Бухарест → хранение 16:35 UTC → показ снова 19:35', () => {
  const ep = zonedToEpoch('2026-06-21', '19:35', 'Europe/Bucharest');
  const stored = utcStamp(new Date(ep));
  assert.equal(stored, '2026-06-21 16:35:00'); // в БД — UTC
  assert.equal(fmtInTz(stored, 'Europe/Bucharest'), '2026-06-21 19:35'); // показываем во времени сайта
  assert.equal(fmtInTz('', 'Europe/Bucharest'), '-');
});
test('раскладка в зоне сайта: окно 09:00–10:00 Вены → UTC-слоты по шагу (одинаково в docker/хосте)', () => {
  // тот же механизм, что scheduleDay: zonedToEpoch(окно, tz) → шаг → utcStamp
  const tz = 'Europe/Vienna';
  const step = 10 * 60000;
  const start = zonedToEpoch('2026-06-19', '09:00', tz);
  const end = zonedToEpoch('2026-06-19', '10:00', tz);
  const slots = [];
  for (let t = start; t <= end; t += step) slots.push(utcStamp(new Date(t)));
  assert.equal(slots.length, 7); // 09:00..10:00 с шагом 10 минут = 7 слотов
  assert.equal(slots[0], '2026-06-19 07:00:00'); // Вена летом = UTC+2 → 09:00 Вены = 07:00 UTC
  assert.equal(slots[6], '2026-06-19 08:00:00'); // 10:00 Вены = 08:00 UTC
  assert.equal(fmtInTz(slots[0], tz), '2026-06-19 09:00'); // показ обратно в зоне сайта
});
