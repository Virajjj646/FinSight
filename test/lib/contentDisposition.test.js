import { test } from "node:test";
import assert from "node:assert/strict";
import { contentDisposition } from "../../src/lib/contentDisposition.js";

const pdf = (baseName, fallbackName = "doc-id") =>
  contentDisposition("inline", { baseName, extension: ".pdf", fallbackName });

test("plain ASCII name goes in both forms", () => {
  assert.equal(pdf("Supply Agreement"), `inline; filename="Supply Agreement.pdf"; filename*=UTF-8''Supply%20Agreement.pdf`);
});

test("quotes, backslashes and slashes cannot break out of the quoted filename", () => {
  const value = pdf('a"b\\c/d');
  assert.match(value, /filename="a_b_c_d\.pdf"/);
  assert.match(value, /filename\*=UTF-8''a%22b_c_d\.pdf$/);
});

test("control characters (header injection) are removed", () => {
  const value = pdf("evil\r\nSet-Cookie: x=1");
  assert.ok(!/[\r\n]/.test(value));
  assert.match(value, /filename="evilSet-Cookie: x=1\.pdf"/);
});

test("non-ASCII names get an ASCII fallback and an RFC 5987 filename*", () => {
  const value = pdf("Vertrag für Müller");
  assert.match(value, /filename="Vertrag f_r M_ller\.pdf"/);
  assert.match(value, /filename\*=UTF-8''Vertrag%20f%C3%BCr%20M%C3%BCller\.pdf$/);
});

test("RFC 5987 escapes ' ( ) *", () => {
  assert.match(pdf("it's (v2)*"), /filename\*=UTF-8''it%27s%20%28v2%29%2A\.pdf$/);
});

test("empty or missing names fall back to the fallback name", () => {
  for (const name of [undefined, null, "", "   ", "\u0000\u0007"]) {
    assert.match(pdf(name, "3f0c"), /filename="3f0c\.pdf"/, JSON.stringify(name));
  }
});

test("very long names are truncated", () => {
  const value = pdf("x".repeat(1000));
  assert.match(value, new RegExp(`filename="x{150}\\.pdf"`));
});
