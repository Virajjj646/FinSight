import { timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../lib/AppError.js";

// Guards system-wide (cross-tenant) operations. Tenant JWT roles can't be used
// here, so access is a shared secret in X-Admin-Token. With ADMIN_TOKEN unset,
// admin routes don't exist.
export function requireAdminToken(req, res, next) {
  if (!env.ADMIN_TOKEN) {
    return next(new AppError("Not found", 404, "NOT_FOUND"));
  }

  const expected = Buffer.from(env.ADMIN_TOKEN);
  const provided = Buffer.from(req.header("X-Admin-Token") ?? "");

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return next(new AppError("Invalid admin token", 401, "UNAUTHENTICATED"));
  }
  next();
}
