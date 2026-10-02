// End-to-end /ask benchmark: ingests the corpus into a throwaway tenant, runs
// every gold question through askQuestion with the real model, and reports
// correctness, citation support and abstention.
//
// Usage:
//   node scripts/bench-ask.js [--gold=path] [--corpus=path] [--only=id1,id2] [--delay=ms] [--keep]
import { writeFile, mkdir } from 'node:fs/promises';
import { env } from '../src/config/env.js';
import { pool } from '../src/infrastructure/db/index.js';
import { embedQuery } from '../src/modules/documents/ingest/embed.js';
import { retrieveChunks } from '../src/modules/documents/retrieval/retrieve.js';
import { askQuestion, ASK_MIN_SCORE, ASK_DEFAULT_K } from '../src/modules/ask/ask.service.js';
import {
  norm,
  pct,
  quantile,
  loadGold,
  loadCorpus,
  validateSpans,
  createBenchTenant,
  ingestCorpus,
  deleteBenchTenant,
} from '../bench/lib/corpus.js';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v = 'true'] = a.slice(2).split('=');
      return [k, v];
    }),
);
const GOLD = args.gold ?? 'bench/retrieval/gold.v2.jsonl';
const CORPUS = args.corpus ?? 'bench/retrieval/corpus.v1.json';
const KEEP = args.keep === 'true';
const ONLY = args.only ? new Set(args.only.split(',')) : null;
const DELAY_MS = args.delay ? Number(args.delay) : 1000; // stay under HF rate limits

const silent = { info() {} };
const ms = (x) => (x == null ? '-' : `${x.toFixed(0)} ms`);

// ---------- load and validate ----------

let gold = await loadGold(GOLD);
if (ONLY) gold = gold.filter((q) => ONLY.has(q.id));

const extracted = await loadCorpus(CORPUS);
const problems = validateSpans(gold, extracted);
for (const q of gold) {
  if (q.answers.length && !(q.facts?.length > 0)) problems.push(`${q.id}: answerable but has no facts`);
}
if (problems.length) {
  console.error(`Gold set problems:\n  ${problems.join('\n  ')}`);
  await pool.end();
  process.exit(1);
}

// ---------- scoring ----------

// Every fact group must have at least one variant in the answer.
function missingFacts(answer, facts) {
  const text = norm(answer);
  return facts.filter((group) => !group.some((variant) => text.includes(norm(variant))));
}

// A citation supports the answer if it points to a chunk from the right
// document that contains a gold span.
function isSupported(q, citations, contentById, docIds) {
  return citations.some((c) =>
    q.answers.some(
      (a) =>
        c.documentId === docIds[a.doc] && norm(contentById.get(c.chunkId)).includes(norm(a.span)),
    ),
  );
}

let tenantId;
try {
  tenantId = await createBenchTenant();
  const { docIds, docKeyById, chunkCounts } = await ingestCorpus(tenantId, extracted);
  await embedQuery('warm up');

  // ---------- run ----------

  const rows = [];
  for (const [i, q] of gold.entries()) {
    if (i > 0 && DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    process.stdout.write(`\r  asking ${i + 1}/${gold.length}...`);

    let retrieved = [];
    const retrieve = async (input) => {
      retrieved = await retrieveChunks(input);
      return retrieved;
    };

    const row = { id: q.id, type: q.type, question: q.question, answerable: q.answers.length > 0 };
    try {
      const r = await askQuestion({ tenantId, question: q.question }, { retrieve, log: silent });
      const contentById = new Map(retrieved.map((c) => [c.chunkId, c.content]));

      Object.assign(row, {
        abstained: r.abstained,
        reason: r.reason ?? null,
        answer: r.answer,
        citations: r.citations.map((c) => ({
          marker: c.marker,
          doc: docKeyById[c.documentId],
          section: c.section,
        })),
        topScore: r.trace.topScore,
        model: r.trace.model,
        llmLatencyMs: r.trace.llmLatencyMs,
        totalLatencyMs: r.trace.totalLatencyMs,
        invalidMarkers: r.trace.invalidMarkers,
      });

      if (row.answerable && !r.abstained) {
        row.missingFacts = missingFacts(r.answer, q.facts);
        row.correct = row.missingFacts.length === 0;
        row.supported = isSupported(q, r.citations, contentById, docIds);
      }
    } catch (err) {
      const upstream = err.upstreamStatus ? ` (upstream ${err.upstreamStatus})` : '';
      row.error = `${err.code ?? 'ERROR'}${upstream}: ${err.message}${err.detail ? ` | ${err.detail}` : ''}`;
    }
    rows.push(row);
  }
  process.stdout.write('\n');

  const ok = rows.filter((r) => !r.error);
  const errors = rows.filter((r) => r.error);
  const answerable = ok.filter((r) => r.answerable);
  const unanswerable = ok.filter((r) => !r.answerable);
  const count = (xs, f) => xs.filter(f).length;
  const rate = (xs, f) => (xs.length ? pct(count(xs, f) / xs.length) : '-');
  const reasons = (xs) =>
    Object.fromEntries(
      [...new Set(xs.filter((r) => r.abstained).map((r) => r.reason))].map((reason) => [
        reason,
        count(xs, (r) => r.reason === reason),
      ]),
    );

  // ---------- report ----------

  console.log(`\nModel: ${ok.find((r) => r.model)?.model ?? env.FINSIGHT_LLM_MODEL}`);
  console.log(`Corpus chunks ${JSON.stringify(chunkCounts)} | k=${ASK_DEFAULT_K} | score floor ${ASK_MIN_SCORE}`);
  console.log(`Questions: ${answerable.length} answerable, ${unanswerable.length} unanswerable, ${errors.length} errors\n`);

  console.log('Answerable questions:');
  console.table({
    all: {
      n: answerable.length,
      answered: rate(answerable, (r) => !r.abstained),
      correct: rate(answerable, (r) => r.correct),
      supported: rate(answerable, (r) => r.supported),
      falseAbstain: rate(answerable, (r) => r.abstained),
    },
    ...Object.fromEntries(
      [...new Set(answerable.map((r) => r.type))].map((type) => {
        const xs = answerable.filter((r) => r.type === type);
        return [
          type,
          {
            n: xs.length,
            answered: rate(xs, (r) => !r.abstained),
            correct: rate(xs, (r) => r.correct),
            supported: rate(xs, (r) => r.supported),
            falseAbstain: rate(xs, (r) => r.abstained),
          },
        ];
      }),
    ),
  });
  console.log('False abstentions by gate:', reasons(answerable));

  console.log('\nUnanswerable questions:');
  console.table({
    all: {
      n: unanswerable.length,
      correctlyAbstained: rate(unanswerable, (r) => r.abstained),
      answeredAnyway: rate(unanswerable, (r) => !r.abstained),
    },
  });
  console.log('Abstentions by gate:', reasons(unanswerable));

  const llm = ok.map((r) => r.llmLatencyMs).filter((x) => x != null);
  const total = ok.map((r) => r.totalLatencyMs);
  console.log(`\nInvalid citation markers: ${ok.reduce((s, r) => s + (r.invalidMarkers ?? 0), 0)}`);
  console.log('Latency:');
  console.table({
    llm: { calls: llm.length, p50: ms(quantile(llm, 0.5)), p95: ms(quantile(llm, 0.95)) },
    total: { calls: total.length, p50: ms(quantile(total, 0.5)), p95: ms(quantile(total, 0.95)) },
  });

  // ---------- failures ----------

  const wrong = answerable.filter((r) => r.abstained || !r.correct || !r.supported);
  console.log(`\nAnswerable failures: ${wrong.length}`);
  for (const r of wrong) {
    console.log(`\n  [${r.type}] ${r.id}: ${r.question}`);
    if (r.abstained) {
      console.log(`    ABSTAINED (${r.reason}), top score ${r.topScore?.toFixed(3)}`);
      continue;
    }
    if (!r.correct) console.log(`    missing facts: ${r.missingFacts.map((g) => g[0]).join(', ')}`);
    if (!r.supported) console.log('    no citation points at the gold clause');
    console.log(`    answer: ${r.answer.replace(/\s+/g, ' ')}`);
    console.log(`    cited: ${r.citations.map((c) => `[${c.marker}] ${c.doc} ${c.section}`).join('; ') || '-'}`);
  }

  const leaked = unanswerable.filter((r) => !r.abstained);
  console.log(`\nUnanswerable but answered: ${leaked.length}`);
  for (const r of leaked) {
    console.log(`\n  ${r.id}: ${r.question}`);
    console.log(`    top score ${r.topScore?.toFixed(3)}`);
    console.log(`    answer: ${r.answer.replace(/\s+/g, ' ')}`);
  }

  for (const r of errors) console.log(`\n  ERROR ${r.id}: ${r.error}`);

  // ---------- save ----------

  await mkdir('bench/ask/results', { recursive: true });
  const file = `bench/ask/results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(
    file,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        config: {
          gold: GOLD,
          corpus: CORPUS,
          model: env.FINSIGHT_LLM_MODEL,
          k: ASK_DEFAULT_K,
          minScore: ASK_MIN_SCORE,
          chunkCounts,
          only: ONLY ? [...ONLY] : null,
          delayMs: DELAY_MS,
        },
        questions: rows,
      },
      null,
      2,
    ),
  );
  console.log(`\nSaved ${file}`);
} finally {
  if (tenantId && !KEEP) await deleteBenchTenant(tenantId);
  else if (tenantId) console.log(`Kept benchmark tenant ${tenantId}`);
  await pool.end();
}