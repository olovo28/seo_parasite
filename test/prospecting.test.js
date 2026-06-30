import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { buildDorks, extractDomains, findArticleLink, findRegisterLink } from '../lib/prospecting/footprints.js';
import { detectEngine, detectUgc, detectDofollow, classifyHtml, classifyDomain } from '../lib/prospecting/classify.js';
import { runClassify, discoverFromUrl, enrichMetrics } from '../lib/prospecting/index.js';
import { addProspect, getProspect, getByDomain, listProspects, updateProspect, computeScore, parseMetricNum, importMetrics, recomputeScores } from '../lib/prospects.js';
import { parseDomainRanks, parseBacklinksOverview } from '../lib/research/api.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  return db;
}

// Фейковый fetch: карта url → html. Неизвестный url → throw (имитация недоступности).
function fakeFetch(map) {
  return async (url) => {
    if (!(url in map)) throw new Error('ENOTFOUND ' + url);
    return { ok: true, status: 200, text: async () => map[url] };
  };
}
// Расширенный фейк: значение либо html-строка, либо { text, url } (для имитации редиректа на res.url).
function fakeFetchEx(map) {
  return async (url) => {
    if (!(url in map)) throw new Error('ENOTFOUND ' + url);
    const v = map[url];
    const text = typeof v === 'string' ? v : v.text;
    const finalUrl = typeof v === 'string' ? url : v.url || url;
    return { ok: true, status: 200, url: finalUrl, text: async () => text };
  };
}

const WP_HOME = '<html><head><meta name="generator" content="WordPress 6.5"></head><body><a href="/wp-login.php">Login</a><script src="/wp-content/x.js"></script></body></html>';

const PEIQ_HOME = `<html><body>
<a href="/register">Kostenlos anmelden</a>
<a href="/a/article/new">Beitrag erstellen</a>
<a href="https://example.com/x">ext follow</a>
<a href="https://spam.com/y" rel="nofollow">ext nofollow</a>
<a href="/internal">int</a>
<article><a href="https://news.example.de/story_a1234567">Story</a></article>
<footer>Powered by PEIQ</footer>
</body></html>`;

// --- footprints ---
test('buildDorks: содержит powered-by-peiq, добавляет seed', () => {
  const d = buildDorks('site:.at');
  assert.ok(Array.isArray(d) && d.length >= 3);
  assert.ok(d.some((q) => /powered by peiq/i.test(q)));
  assert.ok(d.every((q) => q.includes('site:.at')));
});

test('extractDomains: нормализация, дедуп, отброс мусора и ассетов', () => {
  const text =
    'Visit https://www.myheimat.de/foo and lokalkompass.de, also peiq.de and facebook.com/x ' +
    'and https://cdn.example.com/app.js and style.css and MeinBezirk.AT and myheimat.de again';
  const out = extractDomains(text);
  assert.deepEqual(out, ['myheimat.de', 'lokalkompass.de', 'meinbezirk.at']);
});

// --- detectEngine ---
test('detectEngine: powered-by → peiq', () => {
  const r = detectEngine(PEIQ_HOME);
  assert.equal(r.engine, 'peiq');
  assert.ok(r.hits.includes('powered-by-peiq'));
  assert.ok(r.hits.includes('article-id'));
});

test('detectEngine: два слабых сигнала (wysibb + Leserreporter) → peiq', () => {
  const r = detectEngine('<div id="article_content_text"></div> Werde Leserreporter!');
  assert.equal(r.engine, 'peiq');
  assert.ok(r.score >= 2);
});

test('detectEngine: обычный сайт → null', () => {
  const r = detectEngine('<html><body><a href="/login">Login</a></body></html>');
  assert.equal(r.engine, null);
});

test('detectEngine: WordPress → wordpress (не PEIQ)', () => {
  const r = detectEngine(WP_HOME);
  assert.equal(r.engine, 'wordpress');
  assert.equal(r.engines.peiq.qualifies, false);
});

test('detectEngine: PEIQ приоритетнее WP при обоих сигнатурах', () => {
  const r = detectEngine(WP_HOME + ' Powered by PEIQ <div id="article_content_text"></div>');
  assert.equal(r.engine, 'peiq');
});

// --- parse-хелперы ---
test('findArticleLink / findRegisterLink', () => {
  assert.equal(findArticleLink('<a href="/n/x_a1234567">s</a>'), '/n/x_a1234567');
  assert.equal(findArticleLink('<a href="/about">a</a>'), null);
  assert.equal(findRegisterLink('<a href="/user/register">x</a>'), '/user/register');
  assert.equal(findRegisterLink('<a href="/mitmachen/konto">Jetzt registrieren</a>'), '/mitmachen/konto');
  assert.equal(findRegisterLink('<a href="/impressum">Impressum</a>'), null);
});

// --- detectUgc ---
test('detectUgc: регистрация и форма создания', () => {
  assert.deepEqual(detectUgc(PEIQ_HOME), { has_register: 1, has_ugc_form: 1 });
  assert.deepEqual(detectUgc('<a href="/impressum">x</a>'), { has_register: 0, has_ugc_form: 0 });
});

// --- detectDofollow ---
test('detectDofollow: внешние follow → 1, внутренние игнор', () => {
  assert.equal(detectDofollow(PEIQ_HOME, 'mysite.de'), 1);
});

test('detectDofollow: все внешние nofollow → 0', () => {
  const h = '<a href="https://a.com" rel="nofollow">a</a><a href="https://b.com" rel="ugc nofollow">b</a><a href="/in">in</a>';
  assert.equal(detectDofollow(h, 'mysite.de'), 0);
});

test('detectDofollow: внешних нет → null', () => {
  assert.equal(detectDofollow('<a href="/a">a</a><a href="https://mysite.de/x">self</a>', 'mysite.de'), null);
});

// --- classifyHtml ---
test('classifyHtml: агрегирует движок/UGC/dofollow', () => {
  const r = classifyHtml({ home: PEIQ_HOME, domain: 'mysite.de' });
  assert.equal(r.engine, 'peiq');
  assert.equal(r.has_register, 1);
  assert.equal(r.has_ugc_form, 1);
  assert.equal(r.dofollow, 1);
});

// --- classifyDomain (инъектируемый fetch) ---
test('classifyDomain: скачивает home+register, классифицирует', async () => {
  const map = { 'https://foo.de/': PEIQ_HOME, 'https://foo.de/register': '<form id="register_form">registrieren</form>' };
  const r = await classifyDomain('https://WWW.Foo.de/path', { fetchImpl: fakeFetch(map) });
  assert.equal(r.ok, true);
  assert.equal(r.domain, 'foo.de');
  assert.equal(r.engine, 'peiq');
  assert.equal(r.has_register, 1);
  assert.deepEqual(r.fetched, ['home', 'register']);
});

test('classifyDomain: homepage недоступна → ok:false', async () => {
  const r = await classifyDomain('down.de', { fetchImpl: fakeFetch({}) });
  assert.equal(r.ok, false);
  assert.match(r.error, /недоступна/);
});

test('classifyDomain: редирект на другой домен → redirected + движок цели', async () => {
  const map = { 'https://lk.de/': { text: WP_HOME, url: 'https://other.de/' } };
  const r = await classifyDomain('lk.de', { fetchImpl: fakeFetchEx(map) });
  assert.equal(r.ok, true);
  assert.equal(r.redirected, true);
  assert.equal(r.redirectedTo, 'other.de');
  assert.equal(r.engine, 'wordpress');
});

test('classifyDomain: страница-статья усиливает детект PEIQ', async () => {
  const homeWeak = '<html><body><a href="/artikel/test_a1234567">Story</a></body></html>'; // на главной только слабый article-id
  const map = { 'https://x.de/': homeWeak, 'https://x.de/artikel/test_a1234567': '<footer>Powered by PEIQ</footer>' };
  const r = await classifyDomain('x.de', { fetchImpl: fakeFetchEx(map) });
  assert.equal(r.engine, 'peiq');
  assert.ok(r.fetched.includes('article'));
});

test('classifyDomain: ссылка регистрации найдена в HTML (нестандартный путь)', async () => {
  const home = '<html><body><a href="/mitmachen/konto">Jetzt registrieren</a><footer>powered by peiq</footer></body></html>';
  const map = { 'https://y.de/': home, 'https://y.de/mitmachen/konto': '<form>Bitte registrieren Sie sich</form>' };
  const r = await classifyDomain('y.de', { fetchImpl: fakeFetchEx(map) });
  assert.equal(r.engine, 'peiq');
  assert.equal(r.has_register, 1);
  assert.ok(r.fetched.includes('register'));
});

// --- runClassify (персист в БД + авто-qualify) ---
test('runClassify: сохраняет признаки, пишет заметку, авто-qualify', async () => {
  const db = freshDb();
  const id = addProspect(db, { domain: 'foo.de', status: 'new' });
  const map = { 'https://foo.de/': PEIQ_HOME, 'https://foo.de/register': '<form>registrieren</form>' };
  const r = await runClassify(db, id, { fetchImpl: fakeFetch(map) });
  assert.equal(r.ok, true);
  const p = getProspect(db, id);
  assert.equal(p.engine, 'peiq');
  assert.equal(p.has_register, 1);
  assert.equal(p.has_ugc_form, 1);
  assert.equal(p.dofollow, 1);
  assert.equal(p.status, 'qualified'); // авто-перевод
  const notes = db.prepare('SELECT text FROM prospect_notes WHERE prospect_id = ?').all(id).map((n) => n.text);
  assert.ok(notes.some((t) => /классификация/.test(t)));
});

test('runClassify: ошибка сети → заметка, без падения', async () => {
  const db = freshDb();
  const id = addProspect(db, { domain: 'down.de', status: 'new' });
  const r = await runClassify(db, id, { fetchImpl: fakeFetch({}) });
  assert.equal(r.ok, false);
  assert.equal(getProspect(db, id).status, 'new'); // не тронут
});

test('runClassify: движок не определён → engine=unknown (не остаётся импортный peiq)', async () => {
  const db = freshDb();
  const id = addProspect(db, { domain: 'plain.de', engine: 'peiq', status: 'new' }); // импортный дефолт peiq
  const r = await runClassify(db, id, { fetchImpl: fakeFetch({ 'https://plain.de/': '<html><body><a href="/login">Login</a></body></html>' }) });
  assert.equal(r.ok, true);
  const p = getProspect(db, id);
  assert.equal(p.engine, 'unknown'); // правдиво переписан
  assert.equal(p.status, 'new'); // не qualified (не PEIQ / нет UGC)
});

// --- discoverFromUrl (извлечение доменов из источника + импорт) ---
test('discoverFromUrl: извлекает домены и импортирует кандидатов', async () => {
  const db = freshDb();
  const page = '<a href="https://myheimat.de">a</a> lokalkompass.de peiq.de facebook.com mein-suedhessen.de';
  const r = await discoverFromUrl(db, 'https://news.peiq.de/c-kunden', { fetchImpl: fakeFetch({ 'https://news.peiq.de/c-kunden': page }), country: 'de' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.domains, ['myheimat.de', 'lokalkompass.de', 'mein-suedhessen.de']);
  assert.equal(r.added, 3);
  const rows = listProspects(db).map((p) => p.domain).sort();
  assert.deepEqual(rows, ['lokalkompass.de', 'mein-suedhessen.de', 'myheimat.de']);
});

// --- скоринг ---
test('computeScore: гейт UGC, фактор dofollow, веса', () => {
  assert.equal(computeScore({ authority: 100, traffic: 1000000, has_ugc_form: 1, dofollow: 1 }), 100); // максимум
  assert.equal(computeScore({ authority: 100, traffic: 1000000, has_ugc_form: 0, dofollow: 1 }), 20); // нет формы → гейт 0.2
  assert.equal(computeScore({ authority: 100, traffic: 1000000, has_ugc_form: 1, dofollow: 0 }), 30); // nofollow → 0.3
  assert.equal(computeScore({ authority: 0, traffic: 0, has_ugc_form: 1, dofollow: 1 }), 0); // нет мощности
  // выше авторитет → выше скор
  assert.ok(computeScore({ authority: 80, has_ugc_form: 1, dofollow: 1 }) > computeScore({ authority: 30, has_ugc_form: 1, dofollow: 1 }));
});

test('parseMetricNum: суффиксы K/M, разделители тысяч, пустые', () => {
  assert.equal(parseMetricNum('55'), 55);
  assert.equal(parseMetricNum('1.2K'), 1200);
  assert.equal(parseMetricNum('3,4M'), 3400000);
  assert.equal(parseMetricNum('12,345'), 12345);
  assert.equal(parseMetricNum('-'), null);
  assert.equal(parseMetricNum('n/a'), null);
  assert.equal(parseMetricNum(''), null);
});

test('importMetrics: по заголовку, обновляет существующие, считает unmatched, пересчитывает скор', () => {
  const db = freshDb();
  const id = addProspect(db, { domain: 'myheimat.de' });
  updateProspect(db, id, { has_ugc_form: '1', dofollow: '1' }); // годен к публикации
  const csv = 'Domain,Authority Score,Organic Traffic\nmyheimat.de,72,1.2M\nunknown.de,50,100';
  const r = importMetrics(db, csv, { source: 'semrush' });
  assert.equal(r.updated, 1);
  assert.equal(r.unmatched, 1);
  const p = getByDomain(db, 'myheimat.de');
  assert.equal(p.authority, 72);
  assert.equal(p.traffic, 1200000);
  assert.equal(p.metrics_source, 'semrush');
  assert.ok(p.score > 50); // мощный UGC dofollow → высокий скор
});

test('importMetrics: без заголовка, порядок domain,authority,traffic', () => {
  const db = freshDb();
  addProspect(db, { domain: 'x.de' });
  const r = importMetrics(db, 'x.de,40,5000', {});
  assert.equal(r.updated, 1);
  const p = getByDomain(db, 'x.de');
  assert.equal(p.authority, 40);
  assert.equal(p.traffic, 5000);
});

// --- SEMrush метрики домена ---
test('parseDomainRanks / parseBacklinksOverview: реальный CSV', () => {
  const dr = parseDomainRanks('Domain;Rank;Organic Keywords;Organic Traffic\nmyheimat.de;23940;76906;20917');
  assert.equal(dr.rank, 23940);
  assert.equal(dr.organic_keywords, 76906);
  assert.equal(dr.traffic, 20917);
  const bl = parseBacklinksOverview('ascore;total;domains_num\n32;104696;9169');
  assert.equal(bl.authority, 32);
  assert.equal(bl.ref_domains, 9169);
  // ERROR / пусто → null
  assert.equal(parseDomainRanks('ERROR 50 :: NOTHING FOUND').traffic, null);
  assert.equal(parseBacklinksOverview('ascore;total;domains_num').authority, null);
});

test('enrichMetrics: фейковый fetcher → authority/traffic/score, заметка, по стране база', async () => {
  const db = freshDb();
  const id = addProspect(db, { domain: 'myheimat.de', country: 'de' });
  updateProspect(db, id, { has_ugc_form: '1', dofollow: '1' });
  let usedDb = null;
  const fetcher = async (domain, dbCode) => {
    usedDb = dbCode;
    return { authority: 32, traffic: 20917, ref_domains: 9169 };
  };
  const r = await enrichMetrics(db, { fetcher });
  assert.equal(r.enriched, 1);
  assert.equal(usedDb, 'de'); // база выбрана по country кандидата
  const p = getByDomain(db, 'myheimat.de');
  assert.equal(p.authority, 32);
  assert.equal(p.traffic, 20917);
  assert.equal(p.metrics_source, 'semrush');
  assert.ok(p.score > 0);
  const notes = db.prepare('SELECT text FROM prospect_notes WHERE prospect_id=?').all(id).map((n) => n.text);
  assert.ok(notes.some((t) => /метрики SEMrush/.test(t)));
});

test('listProspects sort=score: по убыванию мощности', () => {
  const db = freshDb();
  const a = addProspect(db, { domain: 'weak.de' });
  const b = addProspect(db, { domain: 'strong.de' });
  updateProspect(db, a, { authority: '20', has_ugc_form: '1', dofollow: '1' });
  updateProspect(db, b, { authority: '90', has_ugc_form: '1', dofollow: '1' });
  const ordered = listProspects(db, { sort: 'score' }).map((p) => p.domain);
  assert.deepEqual(ordered.slice(0, 2), ['strong.de', 'weak.de']);
  assert.equal(recomputeScores(db), 2); // бэкофилл проходит по всем
});
