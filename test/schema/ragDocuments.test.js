// test/schema/ragDocuments.test.js
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { eq, inArray, count } from 'drizzle-orm';
import { db } from '../../src/infrastructure/db/index.js';
import { tenants, documents, documentChunks, EMBEDDING_DIMENSIONS} from '../../src/infrastructure/db/schema.js';

const vec = (n = EMBEDDING_DIMENSIONS) => Array(n).fill(0.01);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const pgErr = (err) => err?.cause ?? err; // drizzle 0.44 wraps the pg error

async function insertDoc(tenantId, body = randomUUID()) {
  const [doc] = await db
    .insert(documents)
    .values({ tenantId, title: 'Test contract', contentSha256: sha(body) })
    .returning();
  return doc;
}

function chunkRow(doc, overrides = {}) {
  return {
    tenantId: doc.tenantId,
    documentId: doc.id,
    ordinal: 0,
    pageStart: 1,
    pageEnd: 1,
    content: 'Overdue amounts accrue a late fee of 1.5% per month.',
    tokenCount: 12,
    embedding: vec(),
    embeddingModel: 'Xenova/bge-small-en-v1.5',
    ...overrides,
  };
}

describe('RAG schema: documents & document_chunks', () => {
  let tenantA;
  let tenantB;

  before(async () => {
    [tenantA, tenantB] = await db
      .insert(tenants)
      .values([{ name: `rag-a-${randomUUID()}` }, { name: `rag-b-${randomUUID()}` }])
      .returning();
  });

  beforeEach(async () => {
    // chunks go with them via ON DELETE CASCADE
    await db.delete(documents).where(inArray(documents.tenantId, [tenantA.id, tenantB.id]));
  });

  after(async () => {
    await db.delete(documents).where(inArray(documents.tenantId, [tenantA.id, tenantB.id]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantA.id, tenantB.id]));
  });

  it('rejects a chunk whose tenant differs from its document', async () => {
    const doc = await insertDoc(tenantA.id);

    await assert.rejects(
      async () => {
        await db.insert(documentChunks).values(chunkRow(doc, { tenantId: tenantB.id }));
      },
      (err) =>
        pgErr(err).code === '23503' &&
        pgErr(err).constraint === 'chunks_document_tenant_fk',
    );
  });

  it('rejects duplicate content for one tenant, allows it across tenants', async () => {
    await insertDoc(tenantA.id, 'same-file');

    await assert.rejects(
      async () => {
        await insertDoc(tenantA.id, 'same-file');
      },
      (err) =>
        pgErr(err).code === '23505' &&
        pgErr(err).constraint === 'documents_tenant_sha_uq',
    );

    await assert.doesNotReject(async () => {
      await insertDoc(tenantB.id, 'same-file');
    });
  });

  it('rejects an embedding with the wrong number of dimensions', async () => {
    const doc = await insertDoc(tenantA.id);

    await assert.rejects(
      async () => {
        await db.insert(documentChunks).values(chunkRow(doc, { embedding: vec(EMBEDDING_DIMENSIONS-1) }));
      },
      (err) => pgErr(err).message.includes(`expected ${EMBEDDING_DIMENSIONS} dimensions`),
    );
  });

  it('deletes chunks when their document is deleted', async () => {
    const doc = await insertDoc(tenantA.id);
    await db
      .insert(documentChunks)
      .values([chunkRow(doc, { ordinal: 0 }), chunkRow(doc, { ordinal: 1 })]);

    await db.delete(documents).where(eq(documents.id, doc.id));

    const [{ n }] = await db
      .select({ n: count() })
      .from(documentChunks)
      .where(eq(documentChunks.documentId, doc.id));
    assert.equal(n, 0);
  });
});