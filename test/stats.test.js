import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { parseCockpitStats } from '../lib/sites/meinbezirk.js';
import { saveStatsSnapshot, keywordStats, articleLatestStats, articleStatsRows } from '../lib/stats.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  return db;
}

// HTML-обёртка с инлайн cockpitData (как отдаёт сервер кокпита).
function cockpitHtml(data) {
  return `<html><body><script type="text/javascript">
    const cockpitColors = {"seo":"#47C252"};
    const cockpitData = ${JSON.stringify(data)};
    const cockpitHistogramStartTs = 1782589371;
  </script></body></html>`;
}

test('parseCockpitStats: каналы, перцентиль, время на странице', () => {
  const data = {
    histogram: {
      interval: 'hour',
      total: 50,
      periodStats: [
        { key: 'seo', count: 30 },
        { key: 'intern_rest', count: 15 },
        { key: 'extern_rest', count: 5 },
        { key: 'social', count: 0 },
      ],
    },
    totalcount: { totalcount: 50, avgTimeOnPage: 42.5, countTimeOnPage: 10 },
    percentilesbucket: { values: { '50.01': 10, '60.01': 40, '70.01': 100 }, maxValue: 9999 },
  };
  const s = parseCockpitStats(cockpitHtml(data));
  assert.equal(s.totalViews, 50);
  assert.equal(s.channels.seo, 30);
  assert.equal(s.channels.social, 0);
  assert.equal(s.channels.rest, 20); // intern_rest + extern_rest
  assert.equal(s.avgTimeOnPage, 42.5);
  assert.equal(s.interval, 'hour');
  // 50 ≥ порогов 10(50%) и 40(60%), но < 100(70%) → перцентиль 60
  assert.equal(s.percentile, 60);
});

test('parseCockpitStats: нет cockpitData → ошибка; страница логина → needLogin', () => {
  assert.throws(() => parseCockpitStats('<html><body>ничего</body></html>'), /cockpitData/);
  try {
    parseCockpitStats('<html><body><form><input id="username"></form></body></html>');
    assert.fail('должно было бросить');
  } catch (e) {
    assert.equal(e.needLogin, true);
  }
});

test('parseCockpitStats: нулевой трафик → перцентиль 0, total 0', () => {
  const data = { histogram: { total: 0, periodStats: [] }, totalcount: { totalcount: 0, avgTimeOnPage: null }, percentilesbucket: { values: { '50.01': 1 } } };
  const s = parseCockpitStats(cockpitHtml(data));
  assert.equal(s.totalViews, 0);
  assert.equal(s.percentile, 0);
  assert.equal(s.avgTimeOnPage, null);
  assert.equal(s.channels.seo, 0);
});

function seedArticle(db, { id, keyword, status = 'published' }) {
  db.prepare("INSERT INTO sites (id, name, origin, profile_name) VALUES (1, 'S', 'https://x', 'p') ON CONFLICT DO NOTHING").run();
  db.prepare("INSERT INTO articles (id, site_id, tracking_id, keyword, title, body_html, status, site_url) VALUES (?, 1, ?, ?, 't', 'b', ?, ?)")
    .run(id, `tid-${id}`, keyword, status, `https://x/a_a${id}`);
}

test('saveStatsSnapshot + keywordStats: агрегат по ключу берёт последний снимок на статью', () => {
  const db = freshDb();
  seedArticle(db, { id: 1, keyword: 'sportwetten' });
  seedArticle(db, { id: 2, keyword: 'sportwetten' });
  seedArticle(db, { id: 3, keyword: 'casino' });

  // у статьи 1 два снимка — должен учитываться последний (по MAX(id))
  saveStatsSnapshot(db, 1, { totalViews: 10, percentile: 30, channels: { seo: 2 } }, { reason: 'daily' });
  saveStatsSnapshot(db, 1, { totalViews: 40, percentile: 60, channels: { seo: 12 } }, { reason: 'manual' });
  saveStatsSnapshot(db, 2, { totalViews: 25, percentile: 50, channels: { seo: 8 } }, { reason: 'daily' });
  saveStatsSnapshot(db, 3, { totalViews: 5, percentile: 20, channels: { seo: 0 } }, { reason: 'daily' });

  assert.equal(articleLatestStats(db, 1).total_views, 40); // последний

  const kw = keywordStats(db, 1);
  const byKw = Object.fromEntries(kw.map((r) => [r.keyword, r]));
  assert.equal(byKw.sportwetten.total_views, 40 + 25);
  assert.equal(byKw.sportwetten.seo_views, 12 + 8);
  assert.equal(byKw.sportwetten.best_percentile, 60);
  assert.equal(byKw.sportwetten.articles, 2);
  assert.equal(byKw.casino.seo_views, 0);

  // сортировка: ключ с большим seo впереди
  assert.equal(kw[0].keyword, 'sportwetten');

  // строки по статьям: есть все 3 опубликованные, у 1 — последний снимок
  const rows = articleStatsRows(db, 1);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.id === 1).seo_views, 12);
});
