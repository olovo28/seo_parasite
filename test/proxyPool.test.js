import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { importProxies, assignUnusedProxy } from '../lib/proxyPool.js';
import { swapEmailProxy } from '../lib/emailAccounts.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  return db;
}

function addEmail(db, email, proxy, country = 'at') {
  db.prepare('INSERT INTO email_accounts (provider, email, password, proxy, country) VALUES (?, ?, ?, ?, ?)').run('gmx', email, 'pw', proxy, country);
  return db.prepare('SELECT id FROM email_accounts WHERE email = ?').get(email).id;
}

test('assignUnusedProxy: выдаёт только не закреплённую ни за кем прокси нужной страны', () => {
  const db = freshDb();
  importProxies(db, 'host1:8080\nhost2:8080\nhost3:8080', { country: 'at' });
  importProxies(db, 'de1:8080', { country: 'de' });

  // host1 уже занята почтой → не должна выдаваться
  addEmail(db, 'a@gmx.at', 'host1:8080');

  // assignUnusedProxy сама не «занимает» прокси (занятость = email_accounts.proxy) — поэтому
  // каждую выданную закрепляем новой почтой, иначе она осталась бы свободной (бесконечный цикл).
  const got = [];
  for (let i = 0; i < 5; i++) {
    const p = assignUnusedProxy(db, { country: 'at' });
    if (!p) break;
    got.push(p);
    addEmail(db, `u${i}@gmx.at`, p);
  }
  // свободны были host2 и host3 (host1 занята, de1 — другая страна)
  assert.deepEqual(got.sort(), ['host2:8080', 'host3:8080']);
  // после исчерпания свободных — null
  assert.equal(assignUnusedProxy(db, { country: 'at' }), null);
});

test('assignUnusedProxy: пустой пул страны → null', () => {
  const db = freshDb();
  importProxies(db, 'de1:8080', { country: 'de' });
  assert.equal(assignUnusedProxy(db, { country: 'at' }), null);
});

test('swapEmailProxy: меняет прокси почты на свободную из пула её страны', () => {
  const db = freshDb();
  importProxies(db, 'old:8080\nfree1:8080', { country: 'at' });
  const id = addEmail(db, 'b@gmx.at', 'old:8080', 'at');

  const newProxy = swapEmailProxy(db, id);
  assert.equal(newProxy, 'free1:8080');
  // в БД прокси почты обновилась
  assert.equal(db.prepare('SELECT proxy FROM email_accounts WHERE id = ?').get(id).proxy, 'free1:8080');
  // прокси помечена как выданная
  assert.ok(db.prepare('SELECT last_assigned_at FROM proxies WHERE url = ?').get('free1:8080').last_assigned_at);

  // свободных больше нет (old теперь свободна, но это та же страна — выдастся она)
  const second = swapEmailProxy(db, id);
  assert.equal(second, 'old:8080');
  // теперь обе заняты этой же почтой? нет — у почты одна прокси. old освободилась, free1 закрепилась.
  // третий вызов: свободна только free1 (освободилась после смены на old)
  assert.equal(swapEmailProxy(db, id), 'free1:8080');
});

test('swapEmailProxy: нет свободных прокси → null, прокси не меняется', () => {
  const db = freshDb();
  importProxies(db, 'only:8080', { country: 'at' });
  const id = addEmail(db, 'c@gmx.at', 'only:8080', 'at');
  assert.equal(swapEmailProxy(db, id), null);
  assert.equal(db.prepare('SELECT proxy FROM email_accounts WHERE id = ?').get(id).proxy, 'only:8080');
});
