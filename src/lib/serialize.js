export function serializeLine(line) {
  return { ...line, amountMinor: line.amountMinor.toString() };
}

export function serializeEntry(entry, lines = []) {
  return { ...entry, lines: lines.map(serializeLine) };
}