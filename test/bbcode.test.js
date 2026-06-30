import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToBBCode } from '../lib/bbcode.js';

test('htmlToBBCode: заголовок и жирный', () => {
  const bb = htmlToBBCode('<h2>Заг</h2><p>текст <strong>жир</strong></p>');
  assert.ok(bb.includes('[h2]Заг[/h2]'));
  assert.ok(bb.includes('[b]жир[/b]'));
});

test('htmlToBBCode: ссылка → [urlnt]…[/urlnt], &amp; декодируется', () => {
  const bb = htmlToBBCode('<a href="https://x.com/a?u=1&amp;v=2">A</a>');
  assert.ok(bb.includes('[urlnt=https://x.com/a?u=1&v=2]A[/urlnt]'), bb);
});

test('htmlToBBCode: список → [list][*]…[/*][/list]', () => {
  const bb = htmlToBBCode('<ul><li>один</li><li>два</li></ul>');
  assert.ok(bb.includes('[list]'));
  assert.ok(bb.includes('[*]один[/*]'));
  assert.ok(bb.includes('[/list]'));
});

test('htmlToBBCode: h5/h6 → [h2], blockquote → [quote]', () => {
  assert.ok(htmlToBBCode('<h5>Z</h5>').includes('[h2]Z[/h2]'));
  assert.ok(htmlToBBCode('<blockquote>цитата</blockquote>').includes('[quote]цитата[/quote]'));
});
