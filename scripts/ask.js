// Ask a question against your dev DB for one tenant, using the real model.
// Usage: node scripts/ask.js <tenantId> "<question>" [k]
import { pool } from '../src/infrastructure/db/index.js';
import { askQuestion } from '../src/modules/ask/ask.service.js';

const [tenantId, question, kArg] = process.argv.slice(2);
if (!tenantId || !question) {
  console.error('Usage: node scripts/ask.js <tenantId> "<question>" [k]');
  process.exit(1);
}

const quiet = { info() {} };

try {
  const r = await askQuestion(
    { tenantId, question, k: kArg ? Number(kArg) : undefined },
    { log: quiet },
  );

  console.log(`\nQ: ${question}\n`);
  console.log(r.abstained ? `ABSTAINED (${r.reason}): ${r.answer}` : r.answer);

  if (r.citations.length) {
    console.log('\nCitations:');
    for (const c of r.citations) {
      const pages = c.pageStart === c.pageEnd ? `p${c.pageStart}` : `p${c.pageStart}-${c.pageEnd}`;
      console.log(`  [${c.marker}] ${c.documentTitle ?? '(untitled)'} | ${c.section ?? '-'} | ${pages}`);
    }
  }

  const t = r.trace;
  console.log(
    `\ntop score ${t.topScore?.toFixed(4) ?? '-'} | model ${t.model ?? '(not called)'} | ` +
      `llm ${t.llmLatencyMs?.toFixed(0) ?? '-'} ms | total ${t.totalLatencyMs.toFixed(0)} ms` +
      (t.invalidMarkers ? ` | invalid markers ${t.invalidMarkers}` : ''),
  );
  console.log('retrieved:', t.retrieved.map((x) => x.score.toFixed(3)).join(', '));
} catch (err) {
  console.error(`\nFAILED: ${err.code ?? ''} ${err.message}`);
  if (err.upstreamStatus) console.error(`upstream ${err.upstreamStatus}: ${err.detail}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
