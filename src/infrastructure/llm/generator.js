import { env } from '../../config/env.js';
import { AppError } from '../../lib/AppError.js';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 5_000;

const upstreamError = (message, code, extra = {}) =>
  Object.assign(new AppError(message, 502, code), extra);

// Client for any OpenAI-compatible chat completions API; baseUrl selects the provider.
// Returns generate({ system, prompt }) -> { text, model, usage, finishReason, latencyMs }.
export function createChatGenerator({
  apiKey,
  model,
  baseUrl,
  timeoutMs = 30_000,
  maxTokens = 400,
  fetchImpl = fetch,
}) {
  if (!baseUrl) throw new Error('FINSIGHT_LLM_BASE_URL is not set');
  if (!apiKey) throw new Error('FINSIGHT_LLM_API_KEY is not set');
  if (!model) throw new Error('model is required');

  async function callOnce({ system, prompt }) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        throw new AppError('The answer service timed out', 504, 'LLM_TIMEOUT');
      }
      throw upstreamError('The answer service is unavailable', 'LLM_UNAVAILABLE', {
        retryable: true,
        cause: err,
      });
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      const retryAfterSeconds = Number(res.headers.get('retry-after'));
      throw upstreamError('The answer service returned an error', 'LLM_UPSTREAM_ERROR', {
        retryable: RETRYABLE_STATUS.has(res.status),
        upstreamStatus: res.status,
        retryAfterMs:
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? Math.min(retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
            : null,
        detail,
      });
    }

    const body = await res.json().catch(() => null);
    const choice = body?.choices?.[0];
    if (typeof choice?.message?.content !== 'string') {
      throw upstreamError('The answer service returned an unexpected response', 'LLM_BAD_RESPONSE');
    }
    return {
      text: choice.message.content,
      model: body.model ?? model,
      usage: body.usage ?? null,
      finishReason: choice.finish_reason ?? null,
    };
  }

  return async function generate(input) {
    const started = performance.now();
    let result;
    try {
      result = await callOnce(input);
    } catch (err) {
      if (!err.retryable) throw err;
      await new Promise((resolve) => setTimeout(resolve, err.retryAfterMs ?? RETRY_DELAY_MS));
      result = await callOnce(input);
    }
    return { ...result, latencyMs: performance.now() - started };
  };
}

let defaultGenerator;

// The default generator from env. Missing LLM config is a deployment problem,
// not a bug, so it surfaces as 503 LLM_NOT_CONFIGURED rather than a 500.
// `config` is injectable for tests; only the env-backed generator is cached.
export function getGenerator(config = env) {
  if (!config.FINSIGHT_LLM_BASE_URL || !config.FINSIGHT_LLM_API_KEY) {
    throw new AppError('The answer service is not configured', 503, 'LLM_NOT_CONFIGURED');
  }
  const build = () =>
    createChatGenerator({
      apiKey: config.FINSIGHT_LLM_API_KEY,
      model: config.FINSIGHT_LLM_MODEL,
      baseUrl: config.FINSIGHT_LLM_BASE_URL,
    });
  if (config !== env) return build();
  defaultGenerator ??= build();
  return defaultGenerator;
}