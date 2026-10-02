import { retrieveChunks } from '../documents/retrieval/retrieve.js';
import { getGenerator } from '../../infrastructure/llm/generator.js';
import { logger } from '../../lib/logger.js';
import { buildPrompt } from './ask.prompt.js';
import { parseAnswer } from './ask.parse.js';

// Low floor from the v0 retrieval baseline: 0% false abstains on the gold set.
// It only skips the LLM for clearly off-topic questions; the model's own
// INSUFFICIENT_CONTEXT judgment does the real abstention.
export const ASK_MIN_SCORE = 0.55;
export const ASK_DEFAULT_K = 5;
export const ABSTAIN_MESSAGE = "I couldn't find an answer to that in your documents.";

export async function askQuestion(
  { tenantId, question, k = ASK_DEFAULT_K },
  {
    retrieve = retrieveChunks,
    generate,
    minScore = ASK_MIN_SCORE,
    log = logger,
    // Called once per LLM call, so abstentions before the model are free.
    // Throws to refuse the call (the API passes a per-tenant daily budget).
    consumeLlmBudget = async () => {},
  } = {},
) {
  const started = performance.now();
  const chunks = await retrieve({ tenantId, question, k });
  const topScore = chunks[0]?.score ?? null;

  const trace = {
    topScore,
    retrieved: chunks.map((c) => ({ chunkId: c.chunkId, score: c.score })),
    model: null,
    llmLatencyMs: null,
    invalidMarkers: 0,
  };

  const finish = (result) => {
    trace.totalLatencyMs = performance.now() - started;
    log.info('ask completed', {
      abstained: result.abstained,
      reason: result.reason ?? null,
      topScore,
      retrieved: trace.retrieved,
      cited: result.citations.map((c) => c.chunkId),
      model: trace.model,
      llmLatencyMs: trace.llmLatencyMs,
      totalLatencyMs: trace.totalLatencyMs,
      invalidMarkers: trace.invalidMarkers,
    });
    return { ...result, trace };
  };

  const abstain = (reason) =>
    finish({ abstained: true, reason, answer: ABSTAIN_MESSAGE, citations: [] });

  if (chunks.length === 0) return abstain('no_documents');
  if (topScore < minScore) return abstain('below_score_floor');

  const { system, prompt, used } = buildPrompt(question, chunks);
  await consumeLlmBudget(tenantId);
  const generation = await (generate ?? getGenerator())({ system, prompt });
  trace.model = generation.model;
  trace.llmLatencyMs = generation.latencyMs;

  const parsed = parseAnswer(generation.text, used);
  trace.invalidMarkers = parsed.invalidMarkers ?? 0;

  if (parsed.abstained) return abstain(parsed.reason);
  return finish({ abstained: false, answer: parsed.answer, citations: parsed.citations });
}
