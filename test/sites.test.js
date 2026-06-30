import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter, adapterList } from '../lib/sites/index.js';

test('getAdapter: известный → адаптер с методами; дефолт → meinbezirk; неизвестный → ошибка', () => {
  const a = getAdapter('meinbezirk');
  for (const m of ['login', 'publish', 'deleteArticle', 'parseSiteArticleId', 'previewHtml', 'formatBody']) {
    assert.equal(typeof a[m], 'function', `адаптер должен иметь ${m}`);
  }
  assert.equal(getAdapter(undefined).name, 'meinbezirk');
  assert.throws(() => getAdapter('nope'), /Неизвестный адаптер/);
});

test('parseSiteArticleId: вытаскивает id из URL опубликованной статьи', () => {
  const a = getAdapter('meinbezirk');
  assert.equal(a.parseSiteArticleId('https://www.meinbezirk.at/horn/c-x/y_a8702469'), '8702469');
  assert.equal(a.parseSiteArticleId('https://www.meinbezirk.at/draft/8702412'), null);
  assert.equal(a.parseSiteArticleId(''), null);
  assert.equal(a.parseSiteArticleId(null), null);
});

test('adapterList: содержит meinbezirk с label', () => {
  const list = adapterList();
  const m = list.find((a) => a.name === 'meinbezirk');
  assert.ok(m && typeof m.label === 'string');
});

test('myheimat: зарегистрирован, полный интерфейс (включая регистрацию), pure-функции работают', () => {
  const a = getAdapter('myheimat');
  assert.equal(a.name, 'myheimat');
  // publish/delete + capability регистрации (myheimat — PEIQ, форма регистрации проще)
  for (const m of ['login', 'isLoggedIn', 'publish', 'deleteArticle', 'parseSiteArticleId', 'previewHtml', 'formatBody', 'register', 'confirmRegistration', 'extractConfirmUrl', 'isApproved']) {
    assert.equal(typeof a[m], 'function', `адаптер myheimat должен иметь ${m}`);
  }
  // id статьи (формат PEIQ _aNNNN — общий с meinbezirk)
  assert.equal(a.parseSiteArticleId('https://www.myheimat.de/koeln/c-x/y_a3920104'), '3920104');
  assert.equal(a.parseSiteArticleId('https://www.myheimat.de/profile/123'), null);
  // тело → BBCode, превью → HTML
  assert.ok(a.formatBody('<p>текст <strong>жир</strong></p>').includes('[b]жир[/b]'));
  assert.ok(/<(p|b|strong)/i.test(a.previewHtml('<p><strong>x</strong></p>')));
  // матчер ссылки подтверждения берёт myheimat-ссылку с токеном, чужую — нет
  assert.equal(a.extractConfirmUrl(['https://www.myheimat.de/confirm?token=abc']), 'https://www.myheimat.de/confirm?token=abc');
  assert.equal(a.extractConfirmUrl(['https://other.de/x']), null);
  // одобрение по тексту письма
  assert.equal(a.isApproved({ subject: 'Willkommen', text: 'Du kannst dich jetzt anmelden' }), true);
  assert.equal(a.isApproved({ subject: 'Newsletter', text: 'Angebote' }), false);
});

test('adapterList: содержит все PEIQ-адаптеры', () => {
  const names = adapterList().map((a) => a.name);
  for (const n of ['meinbezirk', 'meine-kirchenzeitung', 'meine-news', 'myheimat']) assert.ok(names.includes(n), `нет ${n}`);
});
