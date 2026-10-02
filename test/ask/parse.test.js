import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswer } from '../../src/modules/ask/ask.parse.js';

const used = [1, 2, 3].map((n) => ({
  chunkId: `c${n}`,
  documentId: `d${n}`,
  documentTitle: `doc${n}.pdf`,
  section: `${n}. Section`,
  pageStart: n,
  pageEnd: n,
  content: '...',
}));

test('maps markers to citations in first-appearance order, deduplicated', () => {
  const r = parseAnswer('The late fee is 1.5% per month [2]. Disputed amounts are exempt [1][2].', used);
  assert.equal(r.abstained, false);
  assert.deepEqual(r.citations.map((c) => c.marker), [2, 1]);
  assert.deepEqual(
    { ...r.citations[0] },
    { marker: 2, chunkId: 'c2', documentId: 'd2', documentTitle: 'doc2.pdf', section: '2. Section', pageStart: 2, pageEnd: 2 },
  );
});

test('accepts list markers like [1, 3]', () => {
  const r = parseAnswer('Both apply [1, 3].', used);
  assert.deepEqual(r.citations.map((c) => c.marker), [1, 3]);
  assert.equal(r.answer, 'Both apply [1][3].');
});

test('drops markers that point to sources that were not sent', () => {
  const r = parseAnswer('Fee is 2% [9]. Term is 3 years [1].', used);
  assert.equal(r.answer, 'Fee is 2%. Term is 3 years [1].');
  assert.equal(r.invalidMarkers, 1);
  assert.deepEqual(r.citations.map((c) => c.marker), [1]);
});

test('an answer with no valid citations becomes an abstention', () => {
  assert.equal(parseAnswer('The fee is 2%.', used).reason, 'no_valid_citations');
  assert.equal(parseAnswer('The fee is 2% [7].', used).reason, 'no_valid_citations');
});

test('the sentinel anywhere in the text is an abstention', () => {
  assert.equal(parseAnswer('INSUFFICIENT_CONTEXT', used).reason, 'model_insufficient_context');
  assert.equal(parseAnswer('Sorry. INSUFFICIENT_CONTEXT [1]', used).abstained, true);
});

test('empty output is an abstention', () => {
  assert.equal(parseAnswer('   ', used).reason, 'empty_answer');
  assert.equal(parseAnswer(undefined, used).reason, 'empty_answer');
});
