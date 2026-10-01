import { pool } from '../src/infrastructure/db/index.js';
import { embedQuery } from '../src/modules/documents/ingest/embed.js';
import { searchChunks, DEFAULT_K } from '../src/modules/documents/retrieval/retrieve.js';

const [tenantId, question, kArg] = process.argv.slice(2);

if (!tenantId || !question) {
  console.error('Usage: node scripts/retrieve.js <tenantId> "<question>" [k]');
  process.exit(1);
}

const k = kArg ? Number(kArg) : DEFAULT_K;

try {
  let t = performance.now();
  const vector = await embedQuery(question);
  const embedMs = performance.now() - t;

  t = performance.now();
  const results = await searchChunks({ tenantId, vector, k });
  const searchMs = performance.now() - t;

  console.log(`Q: ${question}`);
  console.log(
    `embed ${embedMs.toFixed(0)} ms (includes model load) | search ${searchMs.toFixed(0)} ms | ${results.length} results\n`,
  );

  if (results.length === 0) {
    console.log('No chunks. Check the tenant id and that its documents are ready.');
  }

  results.forEach((r, i) => {
    const body = r.content.split('\n\n').slice(1).join('\n\n') || r.content;
    const pages = r.pageStart === r.pageEnd ? `p${r.pageStart}` : `p${r.pageStart}-${r.pageEnd}`;
    console.log(
      `#${i + 1}  ${r.score.toFixed(4)} | ${r.documentTitle ?? '(untitled)'} | ${r.section ?? '-'} | ${pages}`,
    );
    console.log(`    ${body.replace(/\s+/g, ' ').slice(0, 240)}\n`);
  });
} finally {
  await pool.end();
}