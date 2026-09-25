import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createInvoicePaymentSchema } from "../../src/modules/invoices/invoice.payment.schema.js";
import { randomUUID } from "node:crypto";

const validPayment = (paidAt) => ({
  amountMinor: "100",
  paidAt,
  bankAccountId: randomUUID(),
  accountReceivableAccountId: randomUUID(),
});

test("paidAt validation is evaluated at parse time, not frozen at module load", async () => {
  // Regression test for a bug where z.coerce.date().max(new Date(), ...)
  // evaluated `new Date()` once when the schema module was first imported,
  // so any paidAt after that moment - even "now" - was rejected as being in
  // the future. Waiting well past module load and then validating a
  // genuinely-current paidAt would have failed under the old code.
  await delay(1200);

  const result = createInvoicePaymentSchema.safeParse(validPayment(new Date().toISOString()));

  assert.equal(
    result.success,
    true,
    `paidAt of "now", parsed well after module load, must be accepted: ${JSON.stringify(result.error?.issues)}`
  );
});

test("paidAt validation still rejects a date in the future", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const result = createInvoicePaymentSchema.safeParse(validPayment(future));

  assert.equal(result.success, false, "a paidAt one minute in the future must still be rejected");
});
