import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolvePublishAccount, addSiteAccount, parseProxy } from '../lib/accounts.js';

function freshDb() {
  const d = new Database(':memory:');
  d.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  d.prepare("INSERT INTO sites (name, origin, profile_name) VALUES ('s', 'o', 'P')").run();
  return d;
}

test('resolvePublishAccount: запрошенный/дефолт/env/ошибка', () => {
  const d = freshDb();
  const savedU = process.env.MEINBEZIRK_USER;
  const savedP = process.env.MEINBEZIRK_PASS;
  delete process.env.MEINBEZIRK_USER;
  delete process.env.MEINBEZIRK_PASS;
  try {
    assert.throws(() => resolvePublishAccount(d, 1, null), /нет включённых аккаунтов/); // нет аккаунтов и env

    process.env.MEINBEZIRK_USER = 'envu';
    process.env.MEINBEZIRK_PASS = 'envp';
    assert.equal(resolvePublishAccount(d, 1, null).username, 'envu'); // env-фолбэк

    addSiteAccount(d, 1, { username: 'a1', password: 'p1', proxy: '1.2.3.4:8080' });
    addSiteAccount(d, 1, { username: 'a2', password: 'p2' });
    const a2id = d.prepare("SELECT id FROM site_accounts WHERE username='a2'").get().id;
    assert.equal(resolvePublishAccount(d, 1, a2id).username, 'a2'); // запрошенный валиден
    assert.equal(resolvePublishAccount(d, 1, 99999).username, 'a1'); // невалидный → первый включённый
    assert.equal(resolvePublishAccount(d, 1, null).username, 'a1'); // дефолт
  } finally {
    if (savedU !== undefined) process.env.MEINBEZIRK_USER = savedU;
    else delete process.env.MEINBEZIRK_USER;
    if (savedP !== undefined) process.env.MEINBEZIRK_PASS = savedP;
    else delete process.env.MEINBEZIRK_PASS;
  }
});

test('parseProxy: форматы', () => {
  assert.equal(parseProxy(''), null);
  assert.deepEqual(parseProxy('1.2.3.4:8080'), { type: 'http', host: '1.2.3.4', port: 8080, login: undefined, password: undefined });
  assert.deepEqual(parseProxy('1.2.3.4:8080:user:pass'), { type: 'http', host: '1.2.3.4', port: 8080, login: 'user', password: 'pass' });
  assert.deepEqual(parseProxy('socks5://user:pass@1.2.3.4:1080'), { type: 'socks5', host: '1.2.3.4', port: 1080, login: 'user', password: 'pass' });
  assert.deepEqual(parseProxy('https://u:p@h:3128'), { type: 'http', host: 'h', port: 3128, login: 'u', password: 'p' }); // https→http
  assert.throws(() => parseProxy('garbage'), /разобрать прокси/);
});
