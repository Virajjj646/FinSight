import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { extractDocumentText } from '../src/modules/documents/ingest/extract.js';
import { parseStructure } from '../src/modules/documents/ingest/structure.js';
import { chunkDocument } from '../src/modules/documents/ingest/chunk.js';
import { getTokenCounter } from '../src/modules/documents/ingest/model.js';

const file = process.argv[2];
const structure = parseStructure(await extractDocumentText(await readFile(file)));
const chunks = chunkDocument(structure, {
  countTokens: await getTokenCounter(),
  fallbackTitle: basename(file, '.pdf'),
});

for (const c of chunks) {
  console.log(`--- #${c.ordinal} | p${c.pageStart}-${c.pageEnd} | ${c.tokenCount} tok | ${c.section}`);
  console.log(c.content, '\n');
}