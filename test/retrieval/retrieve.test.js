import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../../src/infrastructure/db/index.js';
import {
  tenants,
  documents,
  documentChunks,
  EMBEDDING_DIMENSIONS,
} from '../../src/infrastructure/db/schema.js';
import { EMBEDDING_MODEL } from '../../src/modules/documents/ingest/model.js';
import { embedTexts } from '../../src/modules/documents/ingest/embed.js';
import {
  searchChunks,
  retrieveChunks,
  MAX_K,
} from '../../src/modules/documents/retrieval/retrieve.js';

const tenantIds = [];

after(async () => {
  if (tenantIds.length) {
    await db.delete(documents).where(inArray(documents.tenantId, tenantIds)); // chunks cascade
    await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  }
  await pool.end();
});

// Unit vector with equal weight on the given dimensions.
const unit = (...hot) => {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  for (const i of hot) v[i] = 1 / Math.sqrt(hot.length);
  return v;
};

async function newTenant() {
  const [t] = await db.insert(tenants).values({ name: `x-${randomUUID()}` }).returning();
  tenantIds.push(t.id);
  return t.id;
}

async function insertDoc(tenantId, { status = 'ready', title = 'Test Agreement' } = {}) {
  const [doc] = await db
    .insert(documents)
    .values({ tenantId, title, status, contentSha256: randomBytes(32).toString('hex') })
    .returning();
  return doc;
}

async function insertChunk(doc, ordinal, content, embedding) {
  await db.insert(documentChunks).values({
    tenantId: doc.tenantId,
    documentId: doc.id,
    ordinal,
    section: '1. Test',
    pageStart: 1,
    pageEnd: 1,
    content,
    tokenCount: 5,
    embedding,
    embeddingModel: EMBEDDING_MODEL,
  });
}

test('orders by cosine similarity and returns scores, pages and title', async () => {
  const tenantId = await newTenant();
  const doc = await insertDoc(tenantId);
  await insertChunk(doc, 0, 'orthogonal', unit(1));
  await insertChunk(doc, 1, 'exact', unit(0));
  await insertChunk(doc, 2, 'halfway', unit(0, 1));

  const results = await searchChunks({ tenantId, vector: unit(0), k: 3 });

  assert.deepEqual(results.map((r) => r.content), ['exact', 'halfway', 'orthogonal']);
  assert.ok(Math.abs(results[0].score - 1) < 1e-5);
  assert.ok(Math.abs(results[1].score - Math.SQRT1_2) < 1e-5);
  assert.ok(Math.abs(results[2].score) < 1e-5);
  assert.equal(results[0].documentTitle, 'Test Agreement');
  assert.equal(results[0].documentId, doc.id);
  assert.deepEqual([results[0].section, results[0].pageStart, results[0].pageEnd], ['1. Test', 1, 1]);
});

test('respects k and clamps it to MAX_K', async () => {
  const tenantId = await newTenant();
  const doc = await insertDoc(tenantId);
  for (let i = 0; i < MAX_K + 2; i++) await insertChunk(doc, i, `c${i}`, unit(i));

  assert.equal((await searchChunks({ tenantId, vector: unit(0), k: 2 })).length, 2);
  assert.equal((await searchChunks({ tenantId, vector: unit(0), k: 999 })).length, MAX_K);
  assert.equal((await searchChunks({ tenantId, vector: unit(0), k: 0 })).length, 1);
});

test('only searches documents with status ready', async () => {
  const tenantId = await newTenant();
  const ready = await insertDoc(tenantId);
  const processing = await insertDoc(tenantId, { status: 'processing' });
  await insertChunk(ready, 0, 'ready chunk', unit(1));
  await insertChunk(processing, 0, 'processing chunk', unit(0)); // closer to query

  const results = await searchChunks({ tenantId, vector: unit(0), k: 5 });
  assert.deepEqual(results.map((r) => r.content), ['ready chunk']);
});

test('rejects bad input before touching the DB', async () => {
  await assert.rejects(searchChunks({ tenantId: randomUUID(), vector: [1, 0] }), /dimensions/);
  await assert.rejects(searchChunks({ vector: unit(0) }), /tenantId/);
  await assert.rejects(retrieveChunks({ tenantId: randomUUID(), question: '   ' }), /non-empty/);
});

test('retrieveChunks with the real model ranks the relevant clause first', async () => {
  const tenantId = await newTenant();
  const doc = await insertDoc(tenantId);
  const texts = [
    'Either party may terminate this Agreement with 60 days written notice.',
    'Late payments accrue interest at 1.5% per month on the overdue amount.',
  ];
  const vectors = await embedTexts(texts);
  await insertChunk(doc, 0, texts[0], vectors[0]);
  await insertChunk(doc, 1, texts[1], vectors[1]);

  const [top] = await retrieveChunks({ tenantId, question: 'What is the late payment penalty?' });
  assert.equal(top.content, texts[1]);
});