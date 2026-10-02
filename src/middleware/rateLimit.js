import { redis } from "../infrastructure/redis/index.js";
import { AppError } from "../lib/AppError.js";
import { logger } from "../lib/logger.js";

// The shared client has maxRetriesPerRequest: null, so with Redis down a
// command waits forever. Limiters give up after this and let the request through.
const REDIS_TIMEOUT_MS = 200;

export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis did not answer within ${ms} ms`)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// INCR + EXPIRE in one round trip. Returns the counter after the increment.
export async function incrementCounter(client, key, ttlSec) {
  const [[incrErr, count], [expireErr]] = await client.multi().incr(key).expire(key, ttlSec).exec();
  if (incrErr) throw incrErr;
  if (expireErr) throw expireErr;
  return count;
}

// Fixed-window limiter: at most `limit` requests per `key(req)` per `windowSec`.
// Fails open: if Redis errors or is slow, the request is allowed and a warning is logged.
export function rateLimit({ name, limit, windowSec, key, client = redis, timeoutMs = REDIS_TIMEOUT_MS }) {
  return async function rateLimitMiddleware(req, res, next) {
    const nowSec = Math.floor(Date.now() / 1000);
    const window = Math.floor(nowSec / windowSec);
    const counterKey = `rl:${name}:${key(req)}:${window}`;

    let count;
    try {
      count = await withTimeout(incrementCounter(client, counterKey, windowSec), timeoutMs);
    } catch (error) {
      logger.warn("rate limiter unavailable, allowing request", { limiter: name, error: error.message });
      return next();
    }

    if (count > limit) {
      res.setHeader("Retry-After", String((window + 1) * windowSec - nowSec));
      return next(new AppError("Too many requests, please retry later", 429, "RATE_LIMITED"));
    }
    next();
  };
}
