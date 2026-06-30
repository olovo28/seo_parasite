import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { parseSemrushCsv } from '../lib/research/api.js';
import { scoreKeyword, intentWeight, classifyKeyword } from '../lib/research.js';
import { resolveSemrushAccount, addSemrushAccount, setUnitsBalance, toggleSemrushAccount, cookieEditorToCDP } from '../lib/semrushAccounts.js';

test('parseSemrushCsv: позиционный маппинг колонок, отброс шапки', () => {
  const csv = [
    'Keyword;Search Volume;CPC;Competition;Number of Results;Trends;Intent',
    'sportwetten;40500;0.85;0.45;1200000;0.50,0.60;3',
    'wettanbieter;22000;1.20;0.50;800000;0.40,0.55;0',
  ].join('\n');
  const rows = parseSemrushCsv(csv, ['Ph', 'Nq', 'Cp', 'Co', 'Nr', 'Td', 'In']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { phrase: 'sportwetten', volume: 40500, cpc: 0.85, competition: 0.45, results: 1200000, trend: '0.50,0.60', intent: '3' });
  assert.equal(rows[1].volume, 22000);
  assert.deepEqual(parseSemrushCsv('Keyword;Volume', ['Ph', 'Nq']), []); // только шапка → пусто
});

test('intentWeight: transactional ≫ informational; коды и слова', () => {
  assert.ok(intentWeight('3') > intentWeight('1'));
  assert.ok(intentWeight('transactional') > intentWeight('informational'));
  assert.equal(intentWeight('3'), 1.0);
  assert.ok(intentWeight('0') > intentWeight('2')); // commercial > navigational
});

test('scoreKeyword: ниже KD и коммерч. намерение → выше score', () => {
  const base = { volume: 40500, cpc: 0.85 };
  assert.ok(scoreKeyword({ ...base, kd: 20, intent: '3' }) > scoreKeyword({ ...base, kd: 80, intent: '3' }));
  assert.ok(scoreKeyword({ ...base, kd: 30, intent: '3' }) > scoreKeyword({ ...base, kd: 30, intent: '1' }));
  assert.ok(scoreKeyword({ volume: 50000, kd: 30, intent: '3', cpc: 1 }) > scoreKeyword({ volume: 500, kd: 30, intent: '3', cpc: 1 }));
  assert.ok(Number.isFinite(scoreKeyword({})));
});

test('classifyKeyword: паразитов отклоняем с причиной, нормальные — оставляем', () => {
  assert.equal(classifyKeyword({ phrase: 'sportwetten www bestecasinobonussen de' }).rejected, 1);
  assert.equal(classifyKeyword({ phrase: 'sportwetten www.600freespins.com' }).rejected, 1);
  assert.match(classifyKeyword({ phrase: 'sportwetten www.x.de' }).reason, /www|URL/);
  assert.equal(classifyKeyword({ phrase: 'oddset sportwetten' }).rejected, 0);
  assert.equal(classifyKeyword({ phrase: 'sportwetten.de' }).rejected, 0); // легитимный бренд-домен (нет www)
  assert.equal(classifyKeyword({ phrase: 'sportwetten ohne oasis' }).reason, null);
});

test('cookieEditorToCDP: Cookie-Editor JSON → формат CDP (sameSite/expires/фильтр)', () => {
  const inp = [
    { name: 'sid', value: 'abc', domain: '.semrush.com', path: '/', expirationDate: 1800000000.5, secure: true, httpOnly: true, sameSite: 'no_restriction' },
    { name: 'x', value: '1', domain: 'www.semrush.com', sameSite: 'lax' },
    { name: '', value: 'bad' }, // без name/domain — отфильтровать
  ];
  const cdp = cookieEditorToCDP(inp);
  assert.equal(cdp.length, 2);
  assert.equal(cdp[0].sameSite, 'None');
  assert.equal(cdp[0].expires, 1800000000);
  assert.equal(cdp[0].secure, true);
  assert.equal(cdp[1].path, '/');
  assert.equal(cdp[1].sameSite, 'Lax');
});

test('resolveSemrushAccount: включённый с наибольшим остатком юнитов / по id / нет включённых', () => {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  addSemrushAccount(db, { label: 'a', api_key: 'k1' });
  addSemrushAccount(db, { label: 'b', api_key: 'k2' });
  setUnitsBalance(db, 1, 100);
  setUnitsBalance(db, 2, 5000);
  assert.equal(resolveSemrushAccount(db).id, 2); // больше юнитов
  assert.equal(resolveSemrushAccount(db, 1).id, 1); // явный выбор
  toggleSemrushAccount(db, 1);
  toggleSemrushAccount(db, 2);
  assert.throws(() => resolveSemrushAccount(db), /включённых/);
});
