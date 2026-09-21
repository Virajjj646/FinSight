import { randomUUID } from "node:crypto";
import { requestContext } from "../lib/requestContext.js";
import { logger } from "../lib/logger.js";

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function routePattern(url) {
  return url.split("?")[0].replace(UUID, ":id").replace(/\/+$/, "") || "/";
}

export function requestLogger(req, res, next) {
  const upstreamId = req.header("X-Request-Id");
  const requestId = upstreamId && SAFE_ID.test(upstreamId) ? upstreamId : randomUUID();
  req.id = requestId;
  const start = process.hrtime.bigint();

  res.setHeader("X-Request-Id", requestId);

  requestContext.run({ requestId }, () => {
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const level = res.statusCode >= 500 ? "error"
        : res.statusCode >= 400 ? "warn" : "info";

      logger[level]("request", {
        method: req.method,
        path: routePattern(req.originalUrl),
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    });

    next();
  });
}