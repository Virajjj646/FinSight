import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseStructure } from '../../src/modules/documents/ingest/structure.js';
import { extractDocumentText } from '../../src/modules/documents/ingest/extract.js';

const pages = [
  {
    pageNumber: 1,
    text: [
      'Sample Agreement',
      'This Agreement is made between A and B.',
      '1. Definitions',
      '1.1 "Goods" means the products listed in Schedule',
      '4.',
      '2. Payment Schedule',
      'Advance 20% On acceptance of Purchase Order',
      'Balance 80% On delivery',
      '3. Confidentiality',
    ].join('\n'),
  },
  {
    pageNumber: 2,
    text: [
      '3.1 Each party shall keep information confidential, subject to',
      '3.3 above and applicable law.',
      '3.2 This obligation survives termination.',
    ].join('\n'),
  },
];

test('parses title, preamble, sections and clauses', () => {
  const { title, sections } = parseStructure(pages);
  assert.equal(title, 'Sample Agreement');
  assert.deepEqual(sections.map((s) => s.heading),
    ['Preamble', '1. Definitions', '2. Payment Schedule', '3. Confidentiality']);
});

test('bare "4." from a line wrap is not a heading', () => {
  const def = parseStructure(pages).sections[1];
  assert.equal(def.blocks[0].id, '1.1');
  assert.equal(def.blocks[0].lines.at(-1).text, '4.');
});

test('table rows stay together in the section intro', () => {
  const pay = parseStructure(pages).sections[2];
  assert.equal(pay.blocks.length, 1);
  assert.equal(pay.blocks[0].id, null);
  assert.equal(pay.blocks[0].lines.length, 2);
});

test('heading at page bottom keeps clauses from next page; out-of-order ref ignored', () => {
  const conf = parseStructure(pages).sections[3];
  assert.deepEqual(conf.blocks.map((b) => b.id), ['3.1', '3.2']);
  assert.equal(conf.blocks[0].lines.length, 2);
  assert.equal(conf.blocks[0].lines[0].page, 2);
});

test('acme fixture: sections 4 and 5 with expected clauses', async () => {
  const buf = await readFile('test/fixtures/documents/acme-supply-agreement.pdf');
  const { sections } = parseStructure(await extractDocumentText(buf));
  const s4 = sections.find((s) => s.number === 4);
  const s5 = sections.find((s) => s.number === 5);
  assert.match(s4.heading, /Payment/);
  assert.ok(['4.2', '4.3'].every((id) => s4.blocks.some((b) => b.id === id)));
  assert.ok(s5.blocks.some((b) => b.id === '5.2'));
});