import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db, pool } from '../../src/infrastructure/db/index.js';
import {
  tenants,
  documents,
  documentChunks,
  EMBEDDING_DIMENSIONS,
} from '../../src/infrastructure/db/schema.js';
import { EMBEDDING_MODEL } from '../../src/modules/documents/ingest/model.js';
import { searchChunks, MAX_K } from '../../src/modules/documents/retrieval/retrieve.js';

const CONTENT = 'Late payments accrue interest at 1.5% per month on the overdue amount.';
const SHARED_SHA = randomBytes(32).toString('hex');

// Unit vector at angle `theta` from dimension 0, inside the plane of dims 0 and 1.
const angled = (theta) => {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
};
const QUERY = angled(0);

const tenantIds = [];
let tenantA;
let tenantB;
let docA;
let docB;

async function newTenant() {
  const [t] = await db.insert(tenants).values({ name: `x-${randomUUID()}` }).returning();
  tenantIds.push(t.id);
  return t.id;
}

async function seed(tenantId, embedding) {
  const [doc] = await db
    .insert(documents)
    .values({ tenantId, title: 'Supply Agreement', status: 'ready', contentSha256: SHARED_SHA })
    .returning();
  await db.insert(documentChunks).values({
    tenantId,
    documentId: doc.id,
    ordinal: 0,
    section: '4. Payment Terms',
    pageStart: 2,
    pageEnd: 2,
    content: CONTENT,
    tokenCount: 20,
    embedding,
    embeddingModel: EMBEDDING_MODEL,
  });
  return doc;
}

before(async () => {
  tenantA = await newTenant();
  tenantB = await newTenant();
  docA = await seed(tenantA, angled(0.05)); // near match
  docB = await seed(tenantB, angled(0));    // exact match: always closer than A's
});

after(async () => {
  await db.delete(documents).where(inArray(documents.tenantId, tenantIds)); // chunks cascade
  await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  await pool.end();
});

test('k=1: tenant A gets its own chunk even though B has a closer one', async () => {
  const results = await searchChunks({ tenantId: tenantA, vector: QUERY, k: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].documentId, docA.id);
  assert.ok(results[0].score < 1, 'must be A\'s near match, not B\'s exact match');
});

test('k=MAX_K: tenant A never sees any of tenant B\'s chunks', async () => {
  const results = await searchChunks({ tenantId: tenantA, vector: QUERY, k: MAX_K });
  assert.deepEqual(results.map((r) => r.documentId), [docA.id]);
});

test('tenant B sees only its own chunk', async () => {
  const results = await searchChunks({ tenantId: tenantB, vector: QUERY, k: MAX_K });
  assert.deepEqual(results.map((r) => r.documentId), [docB.id]);
});

test('unknown tenant gets nothing', async () => {
  const results = await searchChunks({ tenantId: randomUUID(), vector: QUERY, k: MAX_K });
  assert.deepEqual(results, []);
});