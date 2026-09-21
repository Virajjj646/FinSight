import { getContext } from "./requestContext.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL ?? "info"] ?? LEVELS.info;

const REDACT = new Set([
  "password", "passwordHash", "token", "accessToken",
  "authorization", "idempotencyKey", "secret",
]);

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT.has(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function emit(level, message, fields = {}) {
  if (LEVELS[level] < threshold) return;

  const { requestId, tenantId, userId } = getContext();

  const line = {
    time: new Date().toISOString(),
    level,
    message,
    ...(requestId && { requestId }),
    ...(tenantId && { tenantId }),
    ...(userId && { userId }),
    ...redact(fields),
  };

  // stderr for warn/error so `node src/app.js 2> errors.log` works.
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + "\n");
}

export const logger = {
  debug: (msg, fields) => emit("debug", msg, fields),
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields),
};
