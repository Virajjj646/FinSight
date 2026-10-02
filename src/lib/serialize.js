// idempotencyKey and requestFingerprint are stored for replay detection only;
// they are internal and never leave the API.
function omitIdempotencyFields(row) {
  const { idempotencyKey: _key, requestFingerprint: _fingerprint, ...rest } = row;
  return rest;
}

export function serializeLine(line) {
  return { ...line, amountMinor: line.amountMinor.toString() };
}

export function serializeJournalEntry(entry) {
  if (!entry) return entry;
  return omitIdempotencyFields(entry);
}

export function serializeEntry(entry, lines = []) {
  return { ...serializeJournalEntry(entry), lines: lines.map(serializeLine) };
}

export function serializePayment(payment) {
  return { ...omitIdempotencyFields(payment), amountMinor: payment.amountMinor.toString() };
}

export function serializeInvoice(invoice) {
  return {
    ...invoice,
    totalAmountMinor: invoice.totalAmountMinor?.toString(),
    sequenceNumber: invoice.sequenceNumber?.toString(),
  };
}
