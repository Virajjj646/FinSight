export function encodeCursor({ occurredAt, id }) {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(cursor) {
  const [ts, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const occurredAt = new Date(ts);
  if (Number.isNaN(occurredAt.getTime()) || !id) return null;
  return { occurredAt, id };
}

// Invoice pagination cursor: encodes only sequenceNumber (a gapless,
// per-tenant integer), not a timestamp - createdAt is millisecond-truncated
// in JS while Postgres stores microseconds, so a timestamp-based cursor can
// silently skip rows created in the same millisecond as a page boundary.
export function encodeSequenceCursor({ sequenceNumber }) {
  return Buffer.from(`${sequenceNumber}`).toString("base64url");
}

export function decodeSequenceCursor(cursor) {
  const raw = Buffer.from(cursor, "base64url").toString();
  if (!/^\d+$/.test(raw)) return null;
  return { sequenceNumber: BigInt(raw) };
}