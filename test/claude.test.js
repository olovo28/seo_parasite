import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArticleParams, parseArticleMessage } from '../lib/claude.js';

test('buildArticleParams: форма запроса (общая для стрима и батча)', () => {
  const p = buildArticleParams({ prompt: 'hi', maxTokens: 12345 });
  assert.equal(p.model, 'claude-opus-4-8');
  assert.equal(p.max_tokens, 12345);
  assert.deepEqual(p.thinking, { type: 'adaptive' });
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.deepEqual(p.output_config.format.schema.required, ['title', 'body_html']);
  assert.deepEqual(p.messages, [{ role: 'user', content: 'hi' }]);
});

test('parseArticleMessage: успешный разбор', () => {
  const msg = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ title: 'T', body_html: '<p>x</p>' }) }], usage: { output_tokens: 5 }, model: 'm' };
  const r = parseArticleMessage(msg);
  assert.equal(r.title, 'T');
  assert.equal(r.body_html, '<p>x</p>');
  assert.equal(r.model, 'm');
});

test('parseArticleMessage: refusal и max_tokens бросают', () => {
  assert.throws(() => parseArticleMessage({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }), /refusal/);
  assert.throws(() => parseArticleMessage({ stop_reason: 'max_tokens', content: [] }, { maxTokens: 100 }), /max_tokens/);
});
