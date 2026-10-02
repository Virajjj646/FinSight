import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startServer } from '../helpers/server.js';
import { registerAndLogin } from '../helpers/fixtures.js';
import { api } from '../helpers/api.js';
import { truncateAll } from '../helpers/db.js';
import { closeTestResources } from '../helpers/teardown.js';
import { db } from '../../src/infrastructure/db/index.js';
import {
  documents,
  documentChunks,
  EMBEDDING_DIMENSIONS,
} from '../../src/infrastructure/db/schema.js';
import { EMBEDDING_MODEL } from '../../src/modules/documents/ingest/model.js';

let server;
let tenantA;
let tenantB;

before(async () => {
  server = await startServer();
  tenantA = await registerAndLogin(server.baseUrl);
  tenantB = await registerAndLogin(server.baseUrl);

  // Tenant B owns a ready document. Retrieval has no score cut-off, so if the
  // tenant filter leaked, this chunk would come back for tenant A's question.
  const [doc] = await db
    .insert(documents)
    .values({
      tenantId: tenantB.tenantId,
      title: 'tenant-b-contract.pdf',
      status: 'ready',
      contentSha256: randomBytes(32).toString('hex'),
    })
    .returning();

  await db.insert(documentChunks).values({
    tenantId: tenantB.tenantId,
    documentId: doc.id,
    ordinal: 0,
    section: '4. Payment Terms',
    pageStart: 1,
    pageEnd: 1,
    content: 'Late payments accrue a late fee of 1.5% per month.',
    tokenCount: 15,
    embedding: new Array(EMBEDDING_DIMENSIONS).fill(1 / Math.sqrt(EMBEDDING_DIMENSIONS)),
    embeddingModel: EMBEDDING_MODEL,
  });

  // Tenant B also has a document mid-ingestion. If the status check leaked
  // across tenants, A would get documents_processing instead of no_documents.
  await db.insert(documents).values({
    tenantId: tenantB.tenantId,
    title: 'tenant-b-processing.pdf',
    status: 'processing',
    contentSha256: randomBytes(32).toString('hex'),
  });
});

after(async () => {
  await server?.close();
  await truncateAll(); // CASCADE from tenants also clears documents and chunks
  await closeTestResources();
});

test("tenant A's /ask never retrieves tenant B's documents", async () => {
  const res = await api(server.baseUrl, tenantA.token)('POST', '/api/ask', {
    body: { question: 'What is the late payment fee?' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.abstained, true);
  // no_documents means retrieval returned nothing for A and B's processing
  // document didn't count for A. Any other reason, or an answer, is a leak.
  assert.equal(res.body.reason, 'no_documents');
  assert.deepEqual(res.body.citations, []);
});
