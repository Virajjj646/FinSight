import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chunkDocument } from '../../src/modules/documents/ingest/chunk.js';
import { parseStructure } from '../../src/modules/documents/ingest/structure.js';
import { extractDocumentText } from '../../src/modules/documents/ingest/extract.js';
import { getTokenCounter } from '../../src/modules/documents/ingest/model.js';

const words = (t) => t.split(/\s+/).filter(Boolean).length;
const blk = (id, text, page) => ({ id, lines: [{ text, page }] });
const body = (c) => c.content.split('\n\n')[1].split('\n');

test('merges small clauses within a section, never across sections', () => {
  const chunks = chunkDocument(
    {
      title: 'T',
      sections: [
        { heading: '1. A', blocks: [blk('1.1', 'one two three', 1), blk('1.2', 'four five', 1)] },
        { heading: '2. B', blocks: [blk('2.1', 'six', 2)] },
      ],
    },
    { countTokens: words, target: 20, cap: 30 },
  );
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].content, 'T — 1. A\n\none two three\nfour five');
  assert.deepEqual(chunks.map((c) => [c.ordinal, c.section, c.pageStart]), [
    [0, '1. A', 1],
    [1, '2. B', 2],
  ]);
});

test('oversized block sub-splits on lines with overlap and respects cap', () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({
    text: `row${i} a b c d`,
    page: i < 5 ? 1 : 2,
  }));
  const chunks = chunkDocument(
    { title: 'T', sections: [{ heading: '1. A', blocks: [{ id: '1.1', lines }] }] },
    { countTokens: words, target: 20, cap: 30 },
  );
  assert.ok(chunks.length > 1);
  const original = new Set(lines.map((l) => l.text));
  for (const c of chunks) {
    assert.ok(c.tokenCount <= 30);
    assert.ok(body(c).every((l) => original.has(l)), 'no line broken');
  }
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(body(chunks[i])[0], body(chunks[i - 1]).at(-1), 'overlap line');
  }
  assert.equal(chunks.at(-1).pageEnd, 2);
});

test('acme fixture with real tokenizer: all chunks under cap, prefixed', async () => {
  const countTokens = await getTokenCounter();
  const buf = await readFile('test/fixtures/documents/acme-supply-agreement.pdf');
  const structure = parseStructure(await extractDocumentText(buf));
  const chunks = chunkDocument(structure, { countTokens, fallbackTitle: 'acme' });

  assert.ok(chunks.length > 0);
  chunks.forEach((c, i) => {
    assert.equal(c.ordinal, i);
    assert.ok(c.tokenCount <= 480, `chunk ${i} is ${c.tokenCount} tokens`);
    assert.ok(c.content.startsWith(`${structure.title ?? 'acme'} — ${c.section}\n\n`));
  });
  assert.ok(chunks.some((c) => /^4\./.test(c.section) && c.content.includes('1.5%')));
});