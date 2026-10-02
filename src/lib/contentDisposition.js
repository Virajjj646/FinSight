// Builds a Content-Disposition header value for a user-supplied file name.
// `filename` is a quoted ASCII fallback; `filename*` (RFC 5987) carries the
// full UTF-8 name for clients that support it.

const MAX_NAME_LENGTH = 150;

// Drops control characters and path separators, collapses whitespace.
function cleanName(name) {
  return String(name ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[\\/]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

// RFC 5987 attr-char: encodeURIComponent leaves ' ( ) * unescaped, which
// are not allowed in an ext-value.
function encodeRfc5987(value) {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// type: "inline" | "attachment". baseName has no extension; extension is
// appended to both forms (e.g. ".pdf"). fallbackName is used when baseName
// cleans to nothing.
export function contentDisposition(type, { baseName, extension, fallbackName }) {
  const name = cleanName(baseName) || cleanName(fallbackName);
  // Quoted-string fallback: printable ASCII only, without " and \.
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}${extension}"; filename*=UTF-8''${encodeRfc5987(name + extension)}`;
}
