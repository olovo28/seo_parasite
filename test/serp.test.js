import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { parseGoogleSerp, findPosition, saveRankSnapshot, latestRanks } from '../lib/serp.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  return db;
}

test('parseGoogleSerp: порядок органики, отсев google-доменов, /url?q=', () => {
  const html = `
    <div><a href="https://www.meinbezirk.at/klagenfurt/c-regionauten-community/x_a8766444"><span></span><h3>Result 1</h3></a></div>
    <div><a href="https://other.com/page"><div></div><h3>Result 2</h3></a></div>
    <a href="https://www.google.com/search?q=z"><h3>Nav (google, отсев)</h3></a>
    <a href="/url?q=https%3A%2F%2Fexample.org%2Fy&sa=U"><h3>Old format</h3></a>
    <a href="https://other.com/page"><h3>Dup (отсев)</h3></a>
  `;
  const urls = parseGoogleSerp(html);
  assert.deepEqual(urls, ['https://www.meinbezirk.at/klagenfurt/c-regionauten-community/x_a8766444', 'https://other.com/page', 'https://example.org/y']);
});

test('findPosition: по matchId (_a<id>) и по домену', () => {
  const urls = ['https://aaa.com/1', 'https://www.meinbezirk.at/x/y_a8766444', 'https://bbb.com/2'];
  assert.deepEqual(findPosition(urls, { matchId: '8766444' }), { position: 2, url: 'https://www.meinbezirk.at/x/y_a8766444' });
  assert.deepEqual(findPosition(urls, { matchId: '999' }), { position: null, url: null });
  assert.equal(findPosition(urls, { domain: 'bbb.com' }).position, 3);
});

test('saveRankSnapshot + latestRanks: берётся последний снимок на статью×страну', () => {
  const db = freshDb();
  db.prepare("INSERT INTO sites (id,name,origin,profile_name) VALUES (1,'S','https://x','p')").run();
  db.prepare("INSERT INTO articles (id,site_id,tracking_id,keyword,title,body_html,status,site_url) VALUES (1,1,'t1','kw','t','b','published','https://x/y_a1')").run();

  saveRankSnapshot(db, 1, { country: 'at', keyword: 'kw', position: 8, source: 'dolphin', depth: 100 });
  saveRankSnapshot(db, 1, { country: 'at', keyword: 'kw', position: 5, source: 'dolphin', depth: 100 }); // новее
  saveRankSnapshot(db, 1, { country: 'de', keyword: 'kw', position: null, source: 'api', error: 'не найдено' });

  const map = latestRanks(db, 1);
  const r = map.get(1);
  assert.equal(r.at.position, 5); // последний AT
  assert.equal(r.de.position, null);
  assert.equal(r.ch, undefined); // CH не проверяли
});
