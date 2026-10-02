import { AppError } from "../lib/AppError.js";

// Runs after authenticate. Allows the request only if the token's role is one of `roles`.
export function requireRole(...roles) {
  const allowed = new Set(roles);
  return function requireRoleMiddleware(req, res, next) {
    if (!allowed.has(req.auth?.role)) {
      return next(new AppError("You do not have permission to perform this action", 403, "FORBIDDEN"));
    }
    next();
  };
}
