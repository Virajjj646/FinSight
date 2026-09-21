// Thin fetch wrapper for hitting a running test server. api(baseUrl, token)
// returns request(method, path, { body, idempotencyKey }) => { status, body }.
export function api(baseUrl, token) {
  return async function request(method, path, { body, idempotencyKey } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
}
