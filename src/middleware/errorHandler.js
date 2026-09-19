import { ZodError } from "zod";
import { AppError } from "../lib/AppError.js";

// pg puts its SQLSTATE on the error, but Drizzle wraps it, so check both.
function sqlState(err) {
  return err?.code ?? err?.causeCode ?? err?.cause?.code;
}

// Drizzle's DrizzleQueryError sets `message` to "Failed query: <sql>\nparams:
// <bound params>" and its `stack` inherits that same first line. The real pg
// DatabaseError underneath (err.cause) carries a short, driver-safe message
// plus constraint/table — never log the Drizzle wrapper for a DB-originated
// error, only what's on the unwrapped driver error.
function driverError(err) {
  return sqlState(err) ? err.cause ?? err : err;
}

const SQLSTATE_RESPONSES = {
  "23505": { status: 409, code: "ALREADY_EXISTS", message: "Resource already exists" }, // unique_violation
  "23503": { status: 422, code: "INVALID_REFERENCE", message: "Referenced resource does not exist" }, // foreign_key_violation
  "23514": { status: 422, code: "CONSTRAINT_VIOLATED", message: "Request violates a data constraint" }, // check_violation
  "22P02": { status: 400, code: "INVALID_INPUT", message: "Malformed identifier in request" }, // invalid_text_representation
};

// Resolves everything the handler needs to both log and respond, computed once.
function classify(err) {
  if (err instanceof ZodError) {
    return { status: 422, code: "VALIDATION_FAILED", expected: true };
  }
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, expected: err.status < 500 };
  }
  const sqlResponse = SQLSTATE_RESPONSES[sqlState(err)];
  if (sqlResponse) {
    return { ...sqlResponse, expected: true, isSqlState: true };
  }
  return { status: 500, code: "INTERNAL_ERROR", expected: false };
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const requestId = req.id;
  const { status, code, expected, isSqlState } = classify(err);
  const isDbError = Boolean(sqlState(err));
  const driverErr = driverError(err);

  if (expected) {
    console.warn({
      requestId,
      method: req.method,
      path: req.originalUrl,
      status,
      code,
      message: driverErr.message,
      ...(isSqlState ? { constraint: driverErr.constraint, table: driverErr.table } : {}),
    });
  } else {
    console.error({
      requestId,
      method: req.method,
      path: req.originalUrl,
      status,
      name: err.name,
      code,
      sqlState: isDbError ? sqlState(err) : undefined,
      // Never err.message/err.stack here: for a DB error those are Drizzle's
      // wrapper and embed the query text plus every bound parameter. `detail`
      // is deliberately omitted too — for 23505 it holds the conflicting value.
      message: driverErr.message,
      constraint: isDbError ? driverErr.constraint : undefined,
      table: isDbError ? driverErr.table : undefined,
      stack: driverErr.stack,
    });
  }

  if (err instanceof ZodError) {
    return res.status(status).json({
      error: {
        requestId,
        code,
        message: "Request validation failed",
        // Field paths and Zod's own messages are safe — they describe the
        // request the client just sent us, not our internals.
        fields: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    });
  }

  if (err instanceof AppError) {
    return res.status(status).json({
      error: { requestId, code, message: err.message },
    });
  }

  if (isSqlState) {
    return res.status(status).json({
      error: { requestId, code, message: SQLSTATE_RESPONSES[sqlState(err)].message },
    });
  }

  return res.status(status).json({
    error: {
      requestId,
      code,
      message: "Something went wrong",
    },
  });
}
