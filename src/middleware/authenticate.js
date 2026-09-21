import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "../lib/AppError.js";
import { requestContext } from "../lib/requestContext.js";

export function authenticate(req, res, next) {
  const header = req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return next(new AppError("Missing or malformed authorization header", 401, "UNAUTHENTICATED"));
  }

  const token = header.slice("Bearer ".length).trim();

  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] });
    req.auth = { userId: payload.sub, tenantId: payload.tenantId, role: payload.role };

    const ctx = requestContext.getStore();
    if (ctx) Object.assign(ctx, { tenantId: payload.tenantId, userId: payload.sub})
    next();
  } catch (error) {
    next(new AppError("Invalid or expired token", 401, "UNAUTHENTICATED"));
  }
}
