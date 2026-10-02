import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { env } from '../../src/config/env.js';
import { startServer } from '../helpers/server.js';
import { registerAndLogin } from '../helpers/fixtures.js';
import { api } from '../helpers/api.js';
import { truncateAll } from '../helpers/db.js';
import { closeTestResources } from '../helpers/teardown.js';
import { db } from '../../src/infrastructure/db/index.js';
import {
  documents,
  documentChunks,
  documentFiles,
  EMBEDDING_DIMENSIONS,
} from '../../src/infrastructure/db/schema.js';
import { EMBEDDING_MODEL } from '../../src/modules/documents/ingest/model.js';
import { searchChunks } from '../../src/modules/documents/retrieval/retrieve.js';
import { writeChunks } from '../../src/modules/documents/ingest/write.js';
import { markDocumentsFailed } from '../../src/modules/documents/document.ingest.js';
import { documentQueue, enqueueIngestion } from '../../src/infrastructure/queue/document.queue.js';
import { processDocumentJob } from '../../src/infrastructure/queue/document.worker.js';

const PDF = Buffer.from('%PDF-1.4\n% test fixture\n');
const VECTOR = new Array(EMBEDDING_DIMENSIONS).fill(1 / Math.sqrt(EMBEDDING_DIMENSIONS));

let server;
let owner;
let other;

before(async () => {
  server = await startServer();
  owner = await registerAndLogin(server.baseUrl);
  other = await registerAndLogin(server.baseUrl);
});

after(async () => {
  // Jobs this suite enqueued; no worker runs in tests, so they are still waiting.
  const jobs = await documentQueue.getJobs(['waiting', 'delayed', 'prioritized', 'paused']);
  await Promise.all(jobs.filter((j) => createdIds.has(j.data.documentId)).map((j) => j.remove()));
  await server?.close();
  await truncateAll(); // CASCADE from tenants clears documents, files and chunks
  await closeTestResources();
});

const createdIds = new Set();

// A document with its file row and one chunk, in the given status.
async function seedDocument(tenantId, status, { error = null } = {}) {
  const [doc] = await db
    .insert(documents)
    .values({ tenantId, title: `${status}.pdf`, status, error, contentSha256: randomBytes(32).toString('hex') })
    .returning();
  createdIds.add(doc.id);
  await db.insert(documentFiles).values({
    documentId: doc.id,
    tenantId,
    mimeType: 'application/pdf',
    sizeBytes: PDF.length,
    bytes: PDF,
  });
  await db.insert(documentChunks).values({
    tenantId,
    documentId: doc.id,
    ordinal: 0,
    section: '1. Terms',
    pageStart: 1,
    pageEnd: 1,
    content: `chunk of ${status} document`,
    tokenCount: 5,
    embedding: VECTOR,
    embeddingModel: EMBEDDING_MODEL,
  });
  return doc;
}

async function rowCounts(documentId) {
  const [d, f, c] = await Promise.all([
    db.select().from(documents).where(eq(documents.id, documentId)),
    db.select().from(documentFiles).where(eq(documentFiles.documentId, documentId)),
    db.select().from(documentChunks).where(eq(documentChunks.documentId, documentId)),
  ]);
  return { documents: d.length, files: f.length, chunks: c.length };
}

function tokenWithRole(user, role) {
  const { sub, tenantId } = jwt.decode(user.token);
  return jwt.sign({ sub, tenantId, role }, env.JWT_SECRET, { expiresIn: '5m' });
}

async function jobsFor(documentId) {
  const jobs = await documentQueue.getJobs(['waiting', 'delayed', 'prioritized', 'paused']);
  return jobs.filter((j) => j.data.documentId === documentId);
}

const as = (token) => api(server.baseUrl, token);

// ---------------------------------------------------------------------------
// POST /api/documents/:id/retry
// ---------------------------------------------------------------------------

test('retry: a failed document goes back to pending and is re-enqueued', async () => {
  const doc = await seedDocument(owner.tenantId, 'failed', { error: 'boom' });
  // The original upload job still exists, as it does in Redis after a failure.
  await enqueueIngestion({ documentId: doc.id, tenantId: owner.tenantId });

  const res = await as(owner.token)('POST', `/api/documents/${doc.id}/retry`);
  assert.equal(res.status, 202);
  assert.equal(res.body.id, doc.id);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.error, null);
  assert.ok(new Date(res.body.updatedAt) > doc.updatedAt, 'updatedAt must advance');

  const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
  assert.equal(row.status, 'pending');
  assert.equal(row.error, null);

  const jobs = await jobsFor(doc.id);
  const retryJobs = jobs.filter((j) => j.id.startsWith(`ingest-${doc.id}-retry-`));
  assert.equal(retryJobs.length, 1, 'retry must add a new job even though ingest-<id> already exists');
  assert.deepEqual(retryJobs[0].data, { documentId: doc.id, tenantId: owner.tenantId });
});

for (const status of ['pending', 'processing', 'ready']) {
  test(`retry: ${status} document gets 409 DOCUMENT_NOT_RETRYABLE and is unchanged`, async () => {
    const doc = await seedDocument(owner.tenantId, status);

    const res = await as(owner.token)('POST', `/api/documents/${doc.id}/retry`);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'DOCUMENT_NOT_RETRYABLE');

    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    assert.equal(row.status, status);
    assert.equal((await jobsFor(doc.id)).length, 0);
  });
}

test("retry: another tenant's failed document is 404 and stays failed", async () => {
  const doc = await seedDocument(owner.tenantId, 'failed', { error: 'boom' });

  const res = await as(other.token)('POST', `/api/documents/${doc.id}/retry`);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'DOCUMENT_NOT_FOUND');

  const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
  assert.equal(row.status, 'failed');
  assert.equal((await jobsFor(doc.id)).length, 0);
});

test('retry: unknown id is 404, malformed id is 422', async () => {
  const missing = await as(owner.token)('POST', `/api/documents/${randomUUID()}/retry`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'DOCUMENT_NOT_FOUND');

  const malformed = await as(owner.token)('POST', '/api/documents/not-a-uuid/retry');
  assert.equal(malformed.status, 422);
  assert.equal(malformed.body.code, 'VALIDATION_FAILED');
});

test('retry: concurrent retries enqueue exactly one job', async () => {
  const doc = await seedDocument(owner.tenantId, 'failed', { error: 'boom' });

  const responses = await Promise.all(
    Array.from({ length: 5 }, () => as(owner.token)('POST', `/api/documents/${doc.id}/retry`)),
  );
  const statuses = responses.map((r) => r.status).sort();
  assert.deepEqual(statuses, [202, 409, 409, 409, 409]);
  assert.equal((await jobsFor(doc.id)).length, 1);
});

// ---------------------------------------------------------------------------
// DELETE /api/documents/:id
// ---------------------------------------------------------------------------

for (const status of ['pending', 'ready', 'failed']) {
  test(`delete: OWNER deletes a ${status} document with its file and chunks`, async () => {
    const doc = await seedDocument(owner.tenantId, status);

    const res = await as(owner.token)('DELETE', `/api/documents/${doc.id}`);
    assert.equal(res.status, 204);
    assert.equal(res.body, undefined);
    assert.deepEqual(await rowCounts(doc.id), { documents: 0, files: 0, chunks: 0 });

    const again = await as(owner.token)('GET', `/api/documents/${doc.id}`);
    assert.equal(again.status, 404);
  });
}

test('delete: ADMIN can delete', async () => {
  const doc = await seedDocument(owner.tenantId, 'ready');
  const res = await as(tokenWithRole(owner, 'ADMIN'))('DELETE', `/api/documents/${doc.id}`);
  assert.equal(res.status, 204);
  assert.deepEqual(await rowCounts(doc.id), { documents: 0, files: 0, chunks: 0 });
});

test('delete: MEMBER gets 403 FORBIDDEN and nothing is deleted', async () => {
  const doc = await seedDocument(owner.tenantId, 'ready');
  const res = await as(tokenWithRole(owner, 'MEMBER'))('DELETE', `/api/documents/${doc.id}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
  assert.deepEqual(await rowCounts(doc.id), { documents: 1, files: 1, chunks: 1 });
});

test('delete: a processing document gets 409 DOCUMENT_BUSY and is kept', async () => {
  const doc = await seedDocument(owner.tenantId, 'processing');
  const res = await as(owner.token)('DELETE', `/api/documents/${doc.id}`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'DOCUMENT_BUSY');
  assert.deepEqual(await rowCounts(doc.id), { documents: 1, files: 1, chunks: 1 });
});

test("delete: another tenant's document is 404 and is kept", async () => {
  const doc = await seedDocument(owner.tenantId, 'ready');
  const res = await as(other.token)('DELETE', `/api/documents/${doc.id}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'DOCUMENT_NOT_FOUND');
  assert.deepEqual(await rowCounts(doc.id), { documents: 1, files: 1, chunks: 1 });
});

test('delete: unknown id is 404, malformed id is 422', async () => {
  const missing = await as(owner.token)('DELETE', `/api/documents/${randomUUID()}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'DOCUMENT_NOT_FOUND');

  const malformed = await as(owner.token)('DELETE', '/api/documents/not-a-uuid');
  assert.equal(malformed.status, 422);
  assert.equal(malformed.body.code, 'VALIDATION_FAILED');
});

test('delete: retrieval and /ask no longer see the deleted document', async () => {
  const tenant = await registerAndLogin(server.baseUrl);
  const doc = await seedDocument(tenant.tenantId, 'ready');

  const before = await searchChunks({ tenantId: tenant.tenantId, vector: VECTOR, k: 5 });
  assert.deepEqual(before.map((c) => c.documentId), [doc.id]);

  const res = await as(tenant.token)('DELETE', `/api/documents/${doc.id}`);
  assert.equal(res.status, 204);

  assert.deepEqual(await searchChunks({ tenantId: tenant.tenantId, vector: VECTOR, k: 5 }), []);

  const asked = await as(tenant.token)('POST', '/api/ask', { body: { question: 'What are the terms?' } });
  assert.equal(asked.status, 200);
  assert.equal(asked.body.abstained, true);
  assert.equal(asked.body.reason, 'no_documents');
});

// ---------------------------------------------------------------------------
// Worker: a job for a deleted document is a no-op
// ---------------------------------------------------------------------------

test('worker: a pending job for a deleted document is skipped, not a crash', async () => {
  const doc = await seedDocument(owner.tenantId, 'pending');
  const res = await as(owner.token)('DELETE', `/api/documents/${doc.id}`);
  assert.equal(res.status, 204);

  const job = { data: { documentId: doc.id, tenantId: owner.tenantId }, attemptsMade: 0, opts: { attempts: 3 } };
  assert.deepEqual(await processDocumentJob(job), { skipped: true });

  // The later stages are no-ops too, should a job get past the claim before a delete.
  const written = await writeChunks({
    documentId: doc.id,
    tenantId: owner.tenantId,
    pageCount: 1,
    chunks: [{ ordinal: 0, section: null, pageStart: 1, pageEnd: 1, content: 'x', tokenCount: 1 }],
    vectors: [VECTOR],
  });
  assert.equal(written, false);
  await markDocumentsFailed({ documentId: doc.id, tenantId: owner.tenantId, error: new Error('late') });

  assert.deepEqual(await rowCounts(doc.id), { documents: 0, files: 0, chunks: 0 });
  const leftovers = await db
    .select()
    .from(documentChunks)
    .where(and(eq(documentChunks.documentId, doc.id), eq(documentChunks.tenantId, owner.tenantId)));
  assert.equal(leftovers.length, 0);
});
