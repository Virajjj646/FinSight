import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { startServer } from '../helpers/server.js';
import { registerAndLogin } from '../helpers/fixtures.js';
import { truncateAll } from '../helpers/db.js';
import { closeTestResources } from '../helpers/teardown.js';
import { db } from '../../src/infrastructure/db/index.js';
import { documents } from '../../src/infrastructure/db/schema.js';

const FIXTURE = new URL('../fixtures/documents/acme-supply-agreement.pdf', import.meta.url);

let server;
let owner;
let other;
let pdfBytes;

before(async () => {
  server = await startServer();
  owner = await registerAndLogin(server.baseUrl);
  other = await registerAndLogin(server.baseUrl);
  pdfBytes = await readFile(FIXTURE);
});

after(async () => {
  await server?.close();
  await truncateAll(); // CASCADE from tenants clears documents and files
  await closeTestResources();
});

async function upload(token, bytes, { title, filename = 'acme-supply-agreement.pdf' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);
  if (title !== undefined) form.append('title', title);
  const res = await fetch(`${server.baseUrl}/api/documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  assert.ok([200, 202].includes(res.status), `upload failed with ${res.status}`);
  return res.json();
}

const download = (token, id) =>
  fetch(`${server.baseUrl}/api/documents/${id}/file`, {
    headers: { Authorization: `Bearer ${token}` },
  });

test('owner downloads the exact bytes uploaded, with PDF headers', async () => {
  const doc = await upload(owner.token, pdfBytes);

  const res = await download(owner.token, doc.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-length'), String(pdfBytes.length));
  assert.equal(
    res.headers.get('content-disposition'),
    `inline; filename="acme-supply-agreement.pdf"; filename*=UTF-8''acme-supply-agreement.pdf`,
  );

  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(pdfBytes), 'downloaded bytes must match the upload');
});

test('the title is sanitised into the file name', async () => {
  const bytes = Buffer.concat([pdfBytes, randomBytes(8)]); // new sha, so a new document
  const doc = await upload(owner.token, bytes, { title: 'Q3 "draft" für Müller' });

  const res = await download(owner.token, doc.id);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get('content-disposition'),
    `inline; filename="Q3 _draft_ f_r M_ller.pdf"; filename*=UTF-8''Q3%20%22draft%22%20f%C3%BCr%20M%C3%BCller.pdf`,
  );
});

test("another tenant gets 404 DOCUMENT_NOT_FOUND for the owner's file", async () => {
  const bytes = Buffer.concat([pdfBytes, randomBytes(8)]);
  const doc = await upload(owner.token, bytes);

  const res = await download(other.token, doc.id);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'DOCUMENT_NOT_FOUND');
});

test('unknown id gets 404 DOCUMENT_NOT_FOUND', async () => {
  const res = await download(owner.token, randomUUID());
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'DOCUMENT_NOT_FOUND');
});

test('a document without a file row gets 404 DOCUMENT_NOT_FOUND', async () => {
  const [doc] = await db
    .insert(documents)
    .values({ tenantId: owner.tenantId, title: 'no-file', contentSha256: randomBytes(32).toString('hex') })
    .returning();

  const res = await download(owner.token, doc.id);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'DOCUMENT_NOT_FOUND');
});

test('malformed id gets 422 VALIDATION_FAILED', async () => {
  const res = await download(owner.token, 'not-a-uuid');
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, 'VALIDATION_FAILED');
});

test('requires authentication', async () => {
  const res = await fetch(`${server.baseUrl}/api/documents/${randomUUID()}/file`);
  assert.equal(res.status, 401);
});
