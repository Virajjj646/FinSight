import { createJournalEntry } from "./ledger.service.js";
import { createJournalEntrySchema, idempotencyKeySchema } from "./ledger.schema.js";

export async function createJournalEntryController(req, res, next){
    try{
        const idempotencyKey = idempotencyKeySchema.parse(req.header("Idempotency-Key"));
        const data = createJournalEntrySchema.parse(req.body);
        const { entry, lines, replayed } = await createJournalEntry({
            tenantId: req.auth.tenantId,
            idempotencyKey,
            data
        });
        res.status(replayed? 200 : 201).json({
            ...entry,
            lines: lines.map((line) => ({ ...line, amountMinor: line.amountMinor.toString() })),
        });
    }catch(error){ next(error); }
}