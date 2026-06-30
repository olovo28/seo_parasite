import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createList, addKeywordsToList, addManualKeywordsToList, setItemStatus, listItems, listLists, getItem } from '../lib/lists.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  return db;
}

test('lists: создание, добавление из kw_keywords с дедупом, статусы, разбивка', () => {
  const db = freshDb();
  db.prepare("INSERT INTO kw_runs (name, source) VALUES ('r', 'api')").run();
  const ins = db.prepare('INSERT INTO kw_keywords (run_id, database, phrase, volume, kd, score) VALUES (1, ?, ?, ?, ?, ?)');
  const a = ins.run('de', 'sportwetten', 1000, 20, 5).lastInsertRowid;
  const b = ins.run('de', 'wettanbieter', 800, 30, 4).lastInsertRowid;

  const listId = createList(db, 'L1');
  assert.equal(addKeywordsToList(db, listId, [a, b]), 2);
  assert.equal(addKeywordsToList(db, listId, [a]), 0); // дедуп по UNIQUE(list_id,phrase,database)

  const items = listItems(db, listId);
  assert.equal(items.length, 2);

  setItemStatus(db, items[0].id, 'winner');
  setItemStatus(db, items[1].id, 'не-валидный'); // должен игнорироваться
  assert.equal(getItem(db, items[1].id).status, 'new');

  const overview = listLists(db);
  assert.equal(overview[0].items, 2);
  assert.equal(overview[0].c_winner, 1);
  assert.equal(overview[0].c_new, 1);

  assert.equal(listItems(db, listId, 'winner').length, 1);
});

test('lists: ручное добавление ключей (1 строка = 1 ключ) с дедупом и очисткой', () => {
  const db = freshDb();
  const listId = createList(db, 'Manual');

  // пустые строки и пробелы игнорируются; повтор (без учёта регистра) внутри вставки дедупится
  const r1 = addManualKeywordsToList(db, listId, '  sportwetten  \n\nwettbonus\nSportwetten\n   \n');
  assert.deepEqual(r1, { added: 2, total: 2 });

  const items = listItems(db, listId);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.phrase).sort(), ['sportwetten', 'wettbonus']);
  // ручные ключи без базы/метрик
  assert.equal(items[0].database, '');
  assert.equal(items[0].status, 'new');

  // повторная вставка существующего ключа не плодит дублей (дедуп по БД)
  const r2 = addManualKeywordsToList(db, listId, 'wettbonus\nlivewetten');
  assert.deepEqual(r2, { added: 1, total: 2 });
  assert.equal(listItems(db, listId).length, 3);

  // пустой ввод
  assert.deepEqual(addManualKeywordsToList(db, listId, '   \n  \n'), { added: 0, total: 0 });
});
