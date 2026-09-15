import { ZodError } from "zod";
import { AppError } from "../lib/AppError.js";

export function errorHandler(error, req, res, next) {
  if (error instanceof ZodError) {
    return res.status(422).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }

  if (error instanceof AppError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
  }

  if (error.code === "23505") {
    return res.status(409).json({
      error: { code: "CONFLICT", message: "Resource already exists" },
    });
  }

  console.error(error.stack);
  return res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
  });
}
