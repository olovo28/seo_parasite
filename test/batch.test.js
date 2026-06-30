import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchResultReason } from '../lib/batch.js';

test('batchResultReason: разбор причин результата батча', () => {
  assert.equal(batchResultReason({ type: 'succeeded' }), 'ok');
  // обёрнутая ошибка { error: { type, message } }
  assert.equal(
    batchResultReason({ type: 'errored', error: { type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } } }),
    'invalid_request_error: bad request',
  );
  // плоская ошибка { type, message }
  assert.equal(batchResultReason({ type: 'errored', error: { type: 'rate_limit_error', message: 'slow down' } }), 'rate_limit_error: slow down');
  // без текста — просто тип результата
  assert.equal(batchResultReason({ type: 'expired' }), 'expired');
  assert.equal(batchResultReason(null), 'нет результата');
});
