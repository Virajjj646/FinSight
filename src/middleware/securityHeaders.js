// Response hardening for a JSON-only API (the subset of helmet's defaults that
// applies here). Nothing is meant to be rendered, framed or embedded.
const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
  "X-Frame-Options": "DENY",
  "X-Permitted-Cross-Domain-Policies": "none",
};

export function securityHeaders(req, res, next) {
  res.set(HEADERS);
  next();
}

const ALLOWED_METHODS = "GET,POST,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Authorization,Content-Type,Idempotency-Key";
const EXPOSED_HEADERS = "Location,Retry-After,Content-Disposition";

// CORS with an exact-match origin allowlist. Auth is a bearer header, not a
// cookie, so credentials are never allowed. Other origins get no CORS headers,
// and the browser blocks the response.
export function cors({ origins }) {
  const allowed = new Set(origins);
  return function corsMiddleware(req, res, next) {
    const origin = req.header("Origin");
    if (!origin) return next();

    res.vary("Origin");
    if (!allowed.has(origin)) return next();

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS);

    if (req.method === "OPTIONS" && req.header("Access-Control-Request-Method")) {
      res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
      res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      res.setHeader("Access-Control-Max-Age", "600");
      return res.status(204).end();
    }
    next();
  };
}
