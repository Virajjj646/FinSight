import { env } from "../../config/env.js";
import { redis } from "../../infrastructure/redis/index.js";
import { AppError } from "../../lib/AppError.js";
import { logger } from "../../lib/logger.js";
import { incrementCounter, withTimeout } from "../../middleware/rateLimit.js";

const REDIS_TIMEOUT_MS = 200;
// The key outlives its UTC day by an hour, then Redis drops it.
const BUDGET_TTL_SEC = 25 * 60 * 60;

// Counts one LLM call against the tenant's daily budget and throws 429 once
// the budget is spent. Fails open if Redis is unavailable.
export async function consumeLlmBudget(
  tenantId,
  { client = redis, limit = env.LLM_DAILY_BUDGET_PER_TENANT, now = new Date(), timeoutMs = REDIS_TIMEOUT_MS } = {},
) {
  const day = now.toISOString().slice(0, 10);
  const key = `llm:${tenantId}:${day}`;

  let count;
  try {
    count = await withTimeout(incrementCounter(client, key, BUDGET_TTL_SEC), timeoutMs);
  } catch (error) {
    logger.warn("LLM budget unavailable, allowing request", { error: error.message });
    return;
  }

  if (count > limit) {
    throw new AppError("Daily question limit reached for this workspace", 429, "LLM_BUDGET_EXCEEDED");
  }
}
