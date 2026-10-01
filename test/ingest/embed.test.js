import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedTexts, embedQuery, EMBEDDING_DIMS } from '../../src/modules/documents/ingest/embed.js';

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

test('produces 384-dim unit vectors, one per input', async () => {
  const vectors = await embedTexts(['alpha', 'beta', 'gamma']);
  assert.equal(vectors.length, 3);
  for (const v of vectors) {
    assert.equal(v.length, EMBEDDING_DIMS);
    assert.ok(Math.abs(dot(v, v) - 1) < 1e-4, 'normalized');
  }
});

test('batching gives the same vectors as a single call', async () => {
  const texts = ['one', 'two', 'three'];
  const whole = await embedTexts(texts);
  const batched = await embedTexts(texts, { batchSize: 1 });
  whole.forEach((v, i) => assert.ok(dot(v, batched[i]) > 0.9999));
});

test('query ranks the relevant clause above an unrelated one', async () => {
  const [late, term] = await embedTexts([
    'Late payments accrue interest at 1.5% per month on the overdue amount.',
    'Either party may terminate this Agreement with 60 days written notice.',
  ]);
  const q = await embedQuery('what is the penalty for paying late?');
  assert.ok(dot(q, late) > dot(q, term));
});