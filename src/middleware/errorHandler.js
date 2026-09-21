import { ZodError } from "zod";
import { AppError } from "../lib/AppError.js";
import { logger } from "../lib/logger.js";
import { getContext } from "../lib/requestContext.js";

// Postgres SQLSTATE format. Must not match our own AppError codes (e.g. "NOT_FOUND").
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

// pg puts its SQLSTATE on the error, but Drizzle sometimes wraps it, so check both.
function sqlState(err) {
  for (const candidate of [err?.code, err?.cause?.code]) {
    if (typeof candidate === "string" && SQLSTATE_PATTERN.test(candidate)) return candidate;
  }
  return undefined;
}

const SQLSTATE_RESPONSES = {
  "23505": { status: 409, code: "CONFLICT", message: "A resource with those details already exists." },
  "23503": { status: 422, code: "INVALID_REFERENCE", message: "The referenced resource does not exist." },
  "23514": { status: 422, code: "CONSTRAINT_VIOLATION", message: "The request does not satisfy a required constraint." },
  "22P02": { status: 400, code: "INVALID_INPUT", message: "One or more fields contain invalid input." },
  "22003": { status: 422, code: "VALUE_OUT_OF_RANGE", message: "A numeric value is out of the allowed range." },
  "40001": { status: 409, code: "RETRYABLE_CONFLICT", message: "The request conflicted with another operation. Please retry." },
  "40P01": { status: 409, code: "RETRYABLE_CONFLICT", message: "The request conflicted with another operation. Please retry." },
};

// Resolves everything the handler needs to respond, computed once, checked in priority order.
function classify(err) {
  if (err?.type === "entity.parse.failed") {
    return { status: 400, code: "INVALID_JSON", message: "The request body is not valid JSON." };
  }
  if (err instanceof ZodError) {
    return { status: 422, code: "VALIDATION_FAILED", message: "Request validation failed." };
  }
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  const state = sqlState(err);
  const sqlResponse = state && SQLSTATE_RESPONSES[state];
  if (sqlResponse) return sqlResponse;
  return { status: 500, code: "INTERNAL_ERROR", message: "Internal server error" };
}

export function errorHandler(err, req, res, next) {
  let requestId;
  try {
    if (res.headersSent) return next(err);

    requestId = getContext().requestId;
    const { status, code, message } = classify(err);

    if (status >= 500) {
      logger.error("unhandled error", {
        err: { name: err?.name, message: err?.message, stack: err?.stack },
      });
    }

    const body = { error: message, code, requestId };
    if (err instanceof ZodError) {
      body.details = err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
    }

    return res.status(status).json(body);
  } catch (handlerErr) {
    logger.error("error handler failed", {
      err: { name: handlerErr?.name, message: handlerErr?.message, stack: handlerErr?.stack },
      originalMessage: err?.message,
    });
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR", requestId });
    }
  }
}
