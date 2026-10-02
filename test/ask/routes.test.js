import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { registerAndLogin } from '../helpers/fixtures.js';
import { api } from '../helpers/api.js';
import { truncateAll } from '../helpers/db.js';
import { closeTestResources } from '../helpers/teardown.js';
import { randomBytes } from 'node:crypto';
import { db } from '../../src/infrastructure/db/index.js';
import { documents } from '../../src/infrastructure/db/schema.js';

let server;
let user;

before(async () => {
  server = await startServer();
  user = await registerAndLogin(server.baseUrl);
});

after(async () => {
  await server?.close();
  await truncateAll();
  await closeTestResources();
});

const ask = (body, token = user.token) => api(server.baseUrl, token)('POST', '/api/ask', { body });

test('requires authentication', async () => {
  const res = await ask({ question: 'What is the late fee?' }, null);
  assert.equal(res.status, 401);
});

test('rejects invalid bodies with 422', async () => {
  for (const body of [
    {},
    { question: '' },
    { question: '   ' },
    { question: 'x'.repeat(1001) },
    { question: 'ok', k: 0 },
    { question: 'ok', k: 21 },
    { question: 'ok', k: 2.5 },
  ]) {
    const res = await ask(body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal(res.body.code, 'VALIDATION_FAILED');
  }
});

test('tenant with no documents gets an abstention and no trace leaks', async () => {
  const res = await ask({ question: 'What is the late fee?' });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['abstained', 'answer', 'citations', 'reason']);
  assert.equal(res.body.abstained, true);
  assert.equal(res.body.reason, 'no_documents');
  assert.deepEqual(res.body.citations, []);
});

const insertDocument = (tenantId, status) =>
  db.insert(documents).values({
    tenantId,
    title: `${status}.pdf`,
    status,
    contentSha256: randomBytes(32).toString('hex'),
  });

for (const status of ['pending', 'processing']) {
  test(`tenant whose only document is ${status} gets documents_processing`, async () => {
    const owner = await registerAndLogin(server.baseUrl);
    await insertDocument(owner.tenantId, status);

    const res = await ask({ question: 'What is the late fee?' }, owner.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.abstained, true);
    assert.equal(res.body.reason, 'documents_processing');
    assert.deepEqual(res.body.citations, []);
  });
}

test('a failed document alone still gives no_documents', async () => {
  const owner = await registerAndLogin(server.baseUrl);
  await insertDocument(owner.tenantId, 'failed');

  const res = await ask({ question: 'What is the late fee?' }, owner.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.reason, 'no_documents');
});
