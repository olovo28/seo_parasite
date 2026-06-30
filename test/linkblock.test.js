import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectBinomLinks, validateBlock, insertLinkBlock, insertLinkBlockMulti, bbcodeToHtml } from '../lib/linkblock.js';

test('injectBinomLinks: s1/s2, ? и & по месту', () => {
  const block = '[urlnt=https://a.com/x]A[/urlnt] [urlnt=https://b.com/y?ref=1]B[/urlnt]';
  const { block: out, links } = injectBinomLinks(block, { articleParam: 's1', linkParam: 's2', trackingId: 'art-1' });
  assert.ok(out.includes('https://a.com/x?s1=art-1&s2=1'));
  assert.ok(out.includes('https://b.com/y?ref=1&s1=art-1&s2=2'));
  assert.equal(links.length, 2);
  assert.equal(links[0].link_id, '1');
  assert.equal(links[1].anchor, 'B');
});

test('validateBlock: корректный и битый', () => {
  assert.equal(validateBlock('[list][*][b]x[/b][/*][/list]').ok, true);
  const bad = validateBlock('[list][*][b]x[/*][/list]');
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.includes('[b]')));
});

test('insertLinkBlock: позиции относительно заголовков', () => {
  const html = '<p>i</p><h2>A</h2><p>a</p><h2>B</h2>';
  assert.ok(insertLinkBlock(html, '[B]', 'start').startsWith('[B]'));
  assert.ok(insertLinkBlock(html, '[B]', 'end').trim().endsWith('[B]'));
  const k1 = insertLinkBlock(html, '[B]', '1');
  assert.ok(k1.indexOf('[B]') < k1.indexOf('<h2>B'));
  assert.ok(k1.indexOf('[B]') > k1.indexOf('<h2>A'));
  // позиций больше, чем заголовков → в конец
  assert.ok(insertLinkBlock(html, '[B]', '9').trim().endsWith('[B]'));
});

test('insertLinkBlockMulti: блок дублируется в нескольких позициях', () => {
  const html = '<p>i</p><h2>A</h2><p>a</p><h2>B</h2><p>b</p><h2>C</h2>';
  // три позиции → три копии блока, не сдвигая друг друга
  const out = insertLinkBlockMulti(html, '[B]', ['start', '1', 'end']);
  assert.equal(out.split('[B]').length - 1, 3, 'три вставки');
  assert.ok(out.startsWith('[B]'), 'start');
  assert.ok(out.trim().endsWith('[B]'), 'end');
  // средняя — между 1-м и 2-м заголовком
  const mid = out.indexOf('[B]', 3); // после стартового
  assert.ok(mid > out.indexOf('<h2>A') && mid < out.indexOf('<h2>B'));
  // дедуп: повторные одинаковые позиции не плодят лишние блоки
  assert.equal(insertLinkBlockMulti(html, '[B]', ['2', '2', 'end', 'end']).split('[B]').length - 1, 2);
  // одна позиция (как раньше)
  assert.equal(insertLinkBlockMulti(html, '[B]', ['1']).split('[B]').length - 1, 1);
  // пусто/невалид → без вставок
  assert.equal(insertLinkBlockMulti(html, '[B]', []), html);
});

test('bbcodeToHtml: базовое превью', () => {
  const h = bbcodeToHtml('[h2]T[/h2][b]x[/b][urlnt=https://a.com]A[/urlnt]');
  assert.ok(h.includes('<h4>T</h4>'));
  assert.ok(h.includes('<b>x</b>'));
  assert.ok(h.includes('href="https://a.com"'));
});
