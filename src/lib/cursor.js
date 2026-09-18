export function encodeCursor({ occurredAt, id }) {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(cursor) {
  const [ts, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const occurredAt = new Date(ts);
  if (Number.isNaN(occurredAt.getTime()) || !id) return null;
  return { occurredAt, id };
}