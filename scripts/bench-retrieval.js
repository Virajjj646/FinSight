// Retrieval benchmark: ingests a fixed corpus into a throwaway tenant, runs the
// gold questions through searchChunks, and reports hit@k, MRR, recall, score
// separation for abstention, latency, and misses.
//
// Usage:
//   node --env-file=.env scripts/bench-retrieval.js [--gold=path] [--corpus=path] [--keep]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/infrastructure/db/index.js';
import { tenants, documents } from '../src/infrastructure/db/schema.js';
import { extractDocumentText } from '../src/modules/documents/ingest/extract.js';
import { parseStructure } from '../src/modules/documents/ingest/structure.js';
import { chunkDocument } from '../src/modules/documents/ingest/chunk.js';
import { getTokenCounter, EMBEDDING_MODEL } from '../src/modules/documents/ingest/model.js';
import { embedTexts, embedQuery } from '../src/modules/documents/ingest/embed.js';
import { writeChunks } from '../src/modules/documents/ingest/write.js';
import { searchChunks } from '../src/modules/documents/retrieval/retrieve.js';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v = 'true'] = a.slice(2).split('=');
      return [k, v];
    }),
);
const GOLD = args.gold ?? 'bench/retrieval/gold.v1.jsonl';
const CORPUS = args.corpus ?? 'bench/retrieval/corpus.v1.json';
const KEEP = args.keep === 'true';
const K_MAX = 10;
const KS = [1, 3, 5, 10];

const norm = (s) =>
  s.replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').toLowerCase().trim();
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const ms = (x) => `${x.toFixed(0)} ms`;

// ---------- load and validate ----------

const corpus = JSON.parse(await readFile(CORPUS, 'utf8'));
const gold = (await readFile(GOLD, 'utf8'))
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const extracted = {};
for (const [key, path] of Object.entries(corpus.documents)) {
  const buffer = await readFile(path);
  const pages = await extractDocumentText(buffer);
  extracted[key] = { path, buffer, pages, text: norm(pages.map((p) => p.text).join('\n')) };
}

const problems = [];
for (const q of gold) {
  for (const a of q.answers) {
    if (!extracted[a.doc]) problems.push(`${q.id}: unknown doc "${a.doc}"`);
    else if (!extracted[a.doc].text.includes(norm(a.span))) {
      problems.push(`${q.id}: span not found in ${a.doc}: "${a.span}"`);
    }
  }
}
if (problems.length) {
  console.error(`Gold set problems:\n  ${problems.join('\n  ')}`);
  await pool.end();
  process.exit(1);
}

// ---------- ingest into a throwaway tenant ----------

async function ingest(tenantId, { buffer, pages, path }, countTokens) {
  const title = basename(path);
  const [doc] = await db
    .insert(documents)
    .values({
      tenantId,
      title,
      status: 'processing',
      contentSha256: createHash('sha256').update(buffer).digest('hex'),
    })
    .returning({ id: documents.id });

  const chunks = chunkDocument(parseStructure(pages), {
    countTokens,
    fallbackTitle: title.replace(/\.pdf$/i, ''),
  });
  const vectors = await embedTexts(chunks.map((c) => c.content));
  const written = await writeChunks({
    documentId: doc.id,
    tenantId,
    pageCount: pages.length,
    chunks,
    vectors,
  });
  if (!written) throw new Error(`could not write chunks for ${title}`);
  return { documentId: doc.id, chunkCount: chunks.length };
}

// A question's answer is found at rank r if the r-th result comes from the
// right document and contains the gold span.
function evaluate(q, results, docIds) {
  const ranks = q.answers.map((a) => {
    const span = norm(a.span);
    const i = results.findIndex(
      (r) => r.documentId === docIds[a.doc] && norm(r.content).includes(span),
    );
    return i === -1 ? null : i + 1;
  });
  const found = ranks.filter((r) => r !== null);
  return { ranks, firstRank: found.length ? Math.min(...found) : null };
}

function summarize(rows) {
  const n = rows.length;
  const out = { n };
  for (const k of KS) {
    out[`hit@${k}`] = pct(rows.filter((r) => r.firstRank && r.firstRank <= k).length / n);
  }
  out['recall@5'] = pct(
    rows.reduce((s, r) => s + r.ranks.filter((x) => x && x <= 5).length / r.ranks.length, 0) / n,
  );
  out.MRR = (rows.reduce((s, r) => s + (r.firstRank ? 1 / r.firstRank : 0), 0) / n).toFixed(3);
  return out;
}

let tenantId;
try {
  const [tenant] = await db
    .insert(tenants)
    .values({ name: `bench-${randomUUID()}` })
    .returning();
  tenantId = tenant.id;

  const countTokens = await getTokenCounter();
  const docIds = {};
  const chunkCounts = {};
  for (const [key, doc] of Object.entries(extracted)) {
    const { documentId, chunkCount } = await ingest(tenantId, doc, countTokens);
    docIds[key] = documentId;
    chunkCounts[key] = chunkCount;
  }
  const docKeyById = Object.fromEntries(Object.entries(docIds).map(([k, id]) => [id, k]));

  // Warm the model and the DB connection so they don't skew latency.
  const warm = await embedQuery('warm up');
  await searchChunks({ tenantId, vector: warm, k: 1 });

  // ---------- run ----------

  const rows = [];
  for (const q of gold) {
    let t = performance.now();
    const vector = await embedQuery(q.question);
    const embedMs = performance.now() - t;

    t = performance.now();
    const results = await searchChunks({ tenantId, vector, k: K_MAX });
    const searchMs = performance.now() - t;

    rows.push({
      id: q.id,
      type: q.type,
      question: q.question,
      answerable: q.answers.length > 0,
      expected: q.answers,
      ...evaluate(q, results, docIds),
      topScore: results[0]?.score ?? 0,
      embedMs,
      searchMs,
      top: results.slice(0, 3).map((r) => ({
        doc: docKeyById[r.documentId],
        section: r.section,
        score: Number(r.score.toFixed(4)),
      })),
    });
  }

  const answerable = rows.filter((r) => r.answerable);
  const unanswerable = rows.filter((r) => !r.answerable);

  // ---------- retrieval quality ----------

  const types = [...new Set(answerable.map((r) => r.type))];
  const summary = {
    all: summarize(answerable),
    ...Object.fromEntries(types.map((t) => [t, summarize(answerable.filter((r) => r.type === t))])),
  };
  console.log(`\nCorpus: ${Object.keys(docIds).length} docs, chunks ${JSON.stringify(chunkCounts)}`);
  console.log(`Gold: ${answerable.length} answerable, ${unanswerable.length} unanswerable\n`);
  console.table(summary);

  // ---------- score separation (abstention) ----------

  const stats = (xs) => ({
    min: Math.min(...xs).toFixed(3),
    median: quantile(xs, 0.5).toFixed(3),
    max: Math.max(...xs).toFixed(3),
  });
  console.log('\nTop-1 score by question kind:');
  console.table({
    answerable: stats(answerable.map((r) => r.topScore)),
    unanswerable: stats(unanswerable.map((r) => r.topScore)),
  });

  const sweep = [];
  for (let t = 0.4; t <= 0.8 + 1e-9; t += 0.01) {
    const threshold = Number(t.toFixed(2));
    const falseAbstain = answerable.filter((r) => r.topScore < threshold).length / answerable.length;
    const falseAnswer =
      unanswerable.filter((r) => r.topScore >= threshold).length / unanswerable.length;
    sweep.push({ threshold, falseAbstain, falseAnswer });
  }
  const best = sweep.reduce((a, b) =>
    b.falseAbstain + b.falseAnswer < a.falseAbstain + a.falseAnswer ? b : a,
  );
  console.log('\nThreshold sweep (abstain if top-1 score < threshold):');
  console.table(
    sweep
      .filter((s) => Math.round(s.threshold * 100) % 5 === 0 || s === best)
      .map((s) => ({
        threshold: s.threshold.toFixed(2) + (s === best ? ' <- best' : ''),
        falseAbstain: pct(s.falseAbstain),
        falseAnswer: pct(s.falseAnswer),
      })),
  );

  // ---------- latency ----------

  const latency = {
    embed: { p50: quantile(rows.map((r) => r.embedMs), 0.5), p95: quantile(rows.map((r) => r.embedMs), 0.95) },
    search: { p50: quantile(rows.map((r) => r.searchMs), 0.5), p95: quantile(rows.map((r) => r.searchMs), 0.95) },
  };
  console.log('\nLatency (warm):');
  console.table({
    embed: { p50: ms(latency.embed.p50), p95: ms(latency.embed.p95) },
    search: { p50: ms(latency.search.p50), p95: ms(latency.search.p95) },
  });

  // ---------- misses ----------

  const misses = answerable.filter((r) => !r.firstRank || r.firstRank > 5);
  console.log(`\nMisses (answer not in top 5): ${misses.length}`);
  for (const m of misses) {
    console.log(`\n  [${m.type}] ${m.id}: ${m.question}`);
    console.log(`    expected: ${m.expected.map((a) => `${a.doc} "${a.span}"`).join(', ')}`);
    console.log(`    found at rank: ${m.firstRank ?? 'not in top ' + K_MAX}`);
    for (const t of m.top) console.log(`    got: ${t.score}  ${t.doc} | ${t.section}`);
  }

  // ---------- save ----------

  await mkdir('bench/retrieval/results', { recursive: true });
  const file = `bench/retrieval/results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(
    file,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        config: { gold: GOLD, corpus: CORPUS, embeddingModel: EMBEDDING_MODEL, kMax: K_MAX, chunkCounts },
        summary,
        separation: { sweep, best },
        latency,
        questions: rows,
      },
      null,
      2,
    ),
  );
  console.log(`\nSaved ${file}`);
} finally {
  if (tenantId && !KEEP) {
    await db.delete(documents).where(eq(documents.tenantId, tenantId)); // chunks cascade
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  } else if (tenantId) {
    console.log(`Kept benchmark tenant ${tenantId}`);
  }
  await pool.end();
}
