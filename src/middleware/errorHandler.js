import { ZodError } from "zod";
import { AppError } from "../lib/AppError.js";

// pg puts its SQLSTATE on the error, but Drizzle wraps it, so check both.
function sqlState(err) {
  return err?.code ?? err?.causeCode ?? err?.cause?.code;
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const requestId = req.id;

  // Everything goes to the log, always, including the SQL.
  console.error({
    requestId,
    method: req.method,
    path: req.originalUrl,
    name: err.name,
    message: err.message,
    sqlState: sqlState(err),
    detail: err.detail,
    constraint: err.constraint,
    table: err.table,
    stack: err.stack,
  });

  if (err instanceof ZodError) {
    return res.status(422).json({
      error: {
        requestId,
        code: "VALIDATION_FAILED",
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
    return res.status(err.status).json({
      error: { requestId, code: err.code, message: err.message },
    });
  }

  switch (sqlState(err)) {
    case "23505": // unique_violation
      return res.status(409).json({
        error: { requestId, code: "ALREADY_EXISTS", message: "Resource already exists" },
      });
    case "23503": // foreign_key_violation
      return res.status(422).json({
        error: { requestId, code: "INVALID_REFERENCE", message: "Referenced resource does not exist" },
      });
    case "23514": // check_violation
      return res.status(422).json({
        error: { requestId, code: "CONSTRAINT_VIOLATED", message: "Request violates a data constraint" },
      });
    case "22P02": // invalid_text_representation
      return res.status(400).json({
        error: { requestId, code: "INVALID_INPUT", message: "Malformed identifier in request" },
      });
  }

  return res.status(500).json({
    error: {
      requestId,
      code: "INTERNAL_ERROR",
      message: "Something went wrong",
    },
  });
}