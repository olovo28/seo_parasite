import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { startWarming } from '../lib/warming.js';
import { dueWarmings, getRegistration } from '../lib/registrations.js';

function freshDb() {
  const d = new Database(':memory:');
  d.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  d.prepare("INSERT INTO sites (name, origin, profile_name) VALUES ('s','https://x.at','P')").run();
  d.prepare("INSERT INTO email_accounts (provider, email, password, proxy) VALUES ('gmx','a@gmx.at','pw','h:1:u:p')").run();
  return d;
}

test('startWarming: регистрация в статусе warming с целью и next_warm_at', () => {
  const d = freshDb();
  const rid = startWarming(d, { siteId: 1, emailAccountId: 1, identity: { name: 'X', password: 'pw' }, siteUsername: 'a@gmx.at', sitePassword: 'pw', target: 4 });
  const reg = getRegistration(d, rid);
  assert.equal(reg.status, 'warming');
  assert.equal(reg.warm_target, 4);
  assert.equal(reg.warm_visits, 0);
  assert.ok(reg.next_warm_at, 'next_warm_at задан');
});

test('dueWarmings: возвращает созревшие warming активного сайта (по next_warm_at)', () => {
  const d = freshDb();
  const rid = startWarming(d, { siteId: 1, emailAccountId: 1, identity: { password: 'pw' }, siteUsername: 'a@gmx.at', sitePassword: 'pw', target: 3 });
  assert.ok(dueWarmings(d, '2999-01-01 00:00:00').some((r) => r.id === rid), 'созрел для будущего now');
  assert.equal(dueWarmings(d, '2000-01-01 00:00:00').length, 0, 'не созрел для прошлого now');
});
