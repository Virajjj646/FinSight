import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatGenerator } from '../../src/infrastructure/llm/generator.js';
import { AppError } from '../../src/lib/AppError.js';

const ok = (content, extra = {}) =>
  new Response(
    JSON.stringify({
      model: 'm',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { total_tokens: 10 },
      ...extra,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

// Records every call and replies with the next queued response (or throws it).
function fakeFetch(...replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(init) : next;
  };
  fn.calls = calls;
  return fn;
}

const make = (fetchImpl, opts = {}) =>
  createChatGenerator({
    apiKey: 't0k',
    model: 'org/model',
    baseUrl: 'https://api.groq.com/openai/v1',
    fetchImpl,
    ...opts,
  });

test('sends an OpenAI-style request and returns the text', async () => {
  const f = fakeFetch(ok('The fee is 1.5% [1].'));
  const r = await make(f)({ system: 'SYS', prompt: 'PROMPT' });

  assert.equal(r.text, 'The fee is 1.5% [1].');
  assert.equal(r.finishReason, 'stop');
  assert.ok(r.latencyMs >= 0);
  assert.equal(f.calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer t0k');
  assert.deepEqual(f.calls[0].body, {
    model: 'org/model',
    temperature: 0,
    max_tokens: 400,
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'PROMPT' },
    ],
  });
});

test('retries once on 503, then succeeds', async () => {
  const f = fakeFetch(new Response('busy', { status: 503 }), ok('fine [1]'));
  const r = await make(f)({ system: 's', prompt: 'p' });
  assert.equal(r.text, 'fine [1]');
  assert.equal(f.calls.length, 2);
});

test('does not retry a 400 and maps it to 502 LLM_UPSTREAM_ERROR', async () => {
  const f = fakeFetch(new Response('bad model', { status: 400 }));
  await assert.rejects(make(f)({ system: 's', prompt: 'p' }), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.status, 502);
    assert.equal(err.code, 'LLM_UPSTREAM_ERROR');
    assert.equal(err.upstreamStatus, 400);
    assert.equal(err.detail, 'bad model');
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test('network failure twice gives 502 LLM_UNAVAILABLE', async () => {
  const f = fakeFetch(new TypeError('fetch failed'), new TypeError('fetch failed'));
  await assert.rejects(make(f)({ system: 's', prompt: 'p' }), { status: 502, code: 'LLM_UNAVAILABLE' });
  assert.equal(f.calls.length, 2);
});

test('timeout gives 504 LLM_TIMEOUT and is not retried', async () => {
  const hang = (init) =>
    new Promise((_, reject) =>
      init.signal.addEventListener('abort', () => reject(init.signal.reason)),
    );
  const f = fakeFetch(hang, hang);
  // AbortSignal.timeout's timer is unref'd; keep the event loop alive while we wait.
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(make(f, { timeoutMs: 20 })({ system: 's', prompt: 'p' }), {
    status: 504,
    code: 'LLM_TIMEOUT',
  });
  clearTimeout(keepAlive);
  assert.equal(f.calls.length, 1);
});

test('a response without message content is 502 LLM_BAD_RESPONSE', async () => {
  const f = fakeFetch(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
  await assert.rejects(make(f)({ system: 's', prompt: 'p' }), { status: 502, code: 'LLM_BAD_RESPONSE' });
});

test('refuses to start without a token', () => {
  assert.throws(
    () => createChatGenerator({ apiKey: '', model: 'm', baseUrl: 'https://api.groq.com/openai/v1' }),
    /LLM_API_KEY/,
  );
});

test('refuses to start without a base URL', () => {
  assert.throws(
    () => createChatGenerator({ apiKey: 'k', model: 'm' }),
    /FINSIGHT_LLM_BASE_URL/,
  );
});

test('429 retry waits for Retry-After (capped) before the second attempt', async () => {
  const f = fakeFetch(
    new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } }),
    ok('fine [1]'),
  );
  const started = performance.now();
  const r = await make(f)({ system: 's', prompt: 'p' });
  assert.equal(r.text, 'fine [1]');
  assert.equal(f.calls.length, 2);
  assert.ok(performance.now() - started >= 950, 'waited about 1 second');
});