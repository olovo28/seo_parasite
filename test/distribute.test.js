import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedToEpoch, epochToZoned } from '../lib/time.js';
import { computeSlotEpochs } from '../lib/distribute.js';

test('epochToZoned: обратное к zonedToEpoch (round-trip)', () => {
  const ep = zonedToEpoch('2026-07-01', '10:00', 'Europe/Vienna');
  assert.deepEqual(epochToZoned(ep, 'Europe/Vienna'), { date: '2026-07-01', time: '10:00' });
  const ep2 = zonedToEpoch('2026-01-01', '23:30', 'Europe/Vienna');
  assert.deepEqual(epochToZoned(ep2, 'Europe/Vienna'), { date: '2026-01-01', time: '23:30' });
});

test('zonedToEpoch: Vienna лето/зима (учёт DST)', () => {
  assert.equal(new Date(zonedToEpoch('2026-07-01', '10:00', 'Europe/Vienna')).toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(new Date(zonedToEpoch('2026-01-01', '10:00', 'Europe/Vienna')).toISOString(), '2026-01-01T09:00:00.000Z');
  assert.equal(new Date(zonedToEpoch('2026-07-01', '10:00', 'Europe/London')).toISOString(), '2026-07-01T09:00:00.000Z');
});

test('computeSlotEpochs: interval и even', () => {
  const s = 1_000_000_000_000;
  const iv = computeSlotEpochs({ startEpoch: s, endEpoch: s + 45 * 60000, mode: 'interval', intervalMin: 15, count: 9 });
  assert.deepEqual(iv.map((x) => (x - s) / 60000), [0, 15, 30, 45]);
  const ev = computeSlotEpochs({ startEpoch: s, endEpoch: s + 120 * 60000, mode: 'even', count: 3 });
  assert.deepEqual(ev.map((x) => (x - s) / 60000), [0, 60, 120]);
  assert.deepEqual(computeSlotEpochs({ startEpoch: s, endEpoch: s + 60000, mode: 'even', count: 1 }), [s]);
});

test('computeSlotEpochs: окно уже идёт → старт подтягивается к следующей минуте от now (нет просроченных слотов)', () => {
  const s = 1_000_000_020_000; // старт окна, кратен 60000 (выровнен на минуту)
  const now = s + 22 * 60000 + 32_000; // «сейчас» = старт+22:32 (внутри окна)
  const end = s + 600 * 60000; // конец далеко
  // interval каждую минуту, 25 статей: без now было бы 0..24 (23 в прошлом); с now — от ceil(now)=+23 мин
  const iv = computeSlotEpochs({ startEpoch: s, endEpoch: end, mode: 'interval', intervalMin: 1, count: 25, nowEpoch: now });
  assert.equal(iv[0], s + 23 * 60000, 'первый слот = следующая целая минута от now');
  assert.ok(iv.every((t) => t >= now), 'ни один слот не в прошлом относительно now');
  assert.deepEqual(iv.slice(0, 3).map((x) => (x - s) / 60000), [23, 24, 25]);

  // even тоже растягивается по ОСТАВШЕМУСЯ окну [now→end], а не от прошедшего старта
  const ev = computeSlotEpochs({ startEpoch: s, endEpoch: end, mode: 'even', count: 3, nowEpoch: now });
  assert.equal(ev[0], s + 23 * 60000, 'even: первый слот тоже от now');
  assert.equal(ev[2], end, 'even: последний слот = конец окна');
  assert.ok(ev.every((t) => t >= now));
});

test('computeSlotEpochs: окно уже закрылось (now > end) → пустой массив', () => {
  const s = 1_000_000_020_000;
  const end = s + 30 * 60000;
  const now = s + 40 * 60000; // позже конца окна
  assert.deepEqual(computeSlotEpochs({ startEpoch: s, endEpoch: end, mode: 'interval', intervalMin: 1, count: 5, nowEpoch: now }), []);
});

test('computeSlotEpochs: окно в будущем → старт НЕ сдвигается (now раньше старта)', () => {
  const s = 1_000_000_000_000;
  const now = s - 60 * 60000; // «сейчас» за час до старта
  const iv = computeSlotEpochs({ startEpoch: s, endEpoch: s + 45 * 60000, mode: 'interval', intervalMin: 15, count: 9, nowEpoch: now });
  assert.deepEqual(iv.map((x) => (x - s) / 60000), [0, 15, 30, 45], 'будущее окно стартует ровно с начала');
});
