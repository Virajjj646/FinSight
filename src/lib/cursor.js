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

// Document pagination cursor: (created_at, id), with created_at kept as the
// Postgres text rendering (microsecond precision, with UTC offset) rather than
// a JS Date, so it can be cast back to timestamptz without losing precision.
// The text is never turned into a Date; Date.UTC below only checks the
// calendar fields, so a tampered cursor is a 400 rather than a failed cast.
const PG_TIMESTAMPTZ_TEXT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?[+-]\d{2}(:\d{2}){0,2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeTimestampCursor({ createdAtText, id }) {
  return Buffer.from(`${createdAtText}|${id}`).toString("base64url");
}

export function decodeTimestampCursor(cursor) {
  const [ts, id, ...rest] = Buffer.from(cursor, "base64url").toString().split("|");
  if (rest.length || !ts || !id || !UUID.test(id)) return null;

  const match = PG_TIMESTAMPTZ_TEXT.exec(ts);
  if (!match) return null;
  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number);
  const check = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;

  return { createdAtText: ts, id };
}
