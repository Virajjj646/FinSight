import { createJournalEntry } from "./ledger.service.js";

export async function createJournalEntryController(req, res, next){
    try{
        const result = await createJournalEntry({
            tenantId: req.tenantId,
            idempotencyKey: req.idempotencyKey,
            data: req.data
        });
        res.status(201).json(result);
    }catch(error){ next(error) }
}