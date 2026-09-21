import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint } from "../../src/lib/idempotency.js";

test("fingerprint distinguishes differently-nested objects that flatten to the same characters", () => {
  // Regression test: canonicalise() used to omit the closing "}" on objects,
  // so {a:{b:1},c:2} and {a:{b:1,c:2}} both produced `{"a":{"b":1,"c":2`.
  const nested = { a: { b: 1 }, c: 2 };
  const flattened = { a: { b: 1, c: 2 } };
  assert.notEqual(fingerprint(nested), fingerprint(flattened));
});

test("fingerprint is stable for the same payload regardless of key order", () => {
  const a = { x: 1, y: 2, description: "sale" };
  const b = { description: "sale", y: 2, x: 1 };
  assert.equal(fingerprint(a), fingerprint(b));
});

test("fingerprint differs when a value actually changes", () => {
  const a = { amountMinor: 100n };
  const b = { amountMinor: 200n };
  assert.notEqual(fingerprint(a), fingerprint(b));
});
