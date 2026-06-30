import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { logArticleEvent, getArticleEvents } from '../lib/events.js';

test('article_events: запись и чтение по статье (UTC-метка)', () => {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  db.prepare("INSERT INTO sites (name, origin, profile_name) VALUES ('s', 'o', 'p')").run();
  const aid = db.prepare("INSERT INTO articles (site_id, tracking_id, title, body_html) VALUES (1, 't', 'T', '<p>x</p>')").run().lastInsertRowid;

  logArticleEvent(db, aid, 'generated', 'создана');
  logArticleEvent(db, aid, 'published', 'опубликована');

  const evs = getArticleEvents(db, aid);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].kind, 'generated');
  assert.equal(evs[1].kind, 'published');
  assert.match(evs[0].ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(getArticleEvents(db, 999), []);
});
