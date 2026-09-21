import { logger } from "./logger.js";

let shuttingDown = false;

export function isShuttingDown() {
  return shuttingDown;
}

export function registerShutdown(steps, { timeoutMs = 10_000 } = {}) {
  let handling = false;

  async function shutdown(signal) {
    if (handling) return;
    handling = true;
    shuttingDown = true;

    logger.info("shutdown started", { signal });

    const timer = setTimeout(() => {
      logger.error("shutdown timed out, forcing exit", { timeoutMs });
      process.exit(1);
    }, timeoutMs);
    timer.unref();

    for (const [name, fn] of steps) {
      try {
        await fn();
        logger.info("shutdown step completed", { step: name });
      } catch (err) {
        logger.error("shutdown step failed", { step: name, error: err.message });
      }
    }

    clearTimeout(timer);
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
