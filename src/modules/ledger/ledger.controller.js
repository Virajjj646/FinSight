import { createJournalEntry } from "./ledger.service.js";
import { createJournalEntrySchema } from "./ledger.schema.js";

export async function createJournalEntryController(req, res, next){
    try{

        const data = createJournalEntrySchema.parse(req.body);
        const result = await createJournalEntry({
            tenantId: req.auth.tenantId,
            idempotencyKey: req.header("Idempotency-Key"),
            data
        });
        res.status(201).json(result);
    }catch(error){ next(error); }
}