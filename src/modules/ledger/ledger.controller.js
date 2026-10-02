import { createJournalEntry, getAccountBalance, listAccountBalances, listEntries } from "./ledger.service.js";
import { balanceQuerySchema, createJournalEntrySchema, idempotencyKeySchema, listEntriesQuerySchema } from "./ledger.schema.js";
import { AppError } from "../../lib/AppError.js";
import { serializeEntry } from "../../lib/serialize.js";

export async function createJournalEntryController(req, res, next){
    try{
        const idempotencyKey = idempotencyKeySchema.parse(req.header("Idempotency-Key"));
        const data = createJournalEntrySchema.parse(req.body);
        const { entry, lines, replayed } = await createJournalEntry({
            tenantId: req.auth.tenantId,
            idempotencyKey,
            data
        });
        res.status(replayed? 200 : 201).json(serializeEntry(entry, lines));
    }catch(error){ next(error); }
}

export async function listEntriesController(req, res, next){
    try{
        const query = listEntriesQuerySchema.parse(req.query);

        if(query.from && query.to && query.from > query.to){
            throw new AppError("'from' must not be after 'to",422, "INVALID_RANGE");
        }

        const{ data, nextCursor } = await listEntries({
            tenantId: req.auth.tenantId,
            ...query,
        });

        res.json({
            data: data.map((entry) => serializeEntry(entry, entry.lines)),
            nextCursor,
        });
    }catch(error){
        next(error);
    }
}

export async function getAccountBalanceController(req, res, next){
    try{
        const { asOf } = balanceQuerySchema.parse(req.query);

        const balance = await getAccountBalance({
            tenantId: req.auth.tenantId,
            accountId: req.params.accountId,
            asOf
        });

        res.json(balance);
    }catch(error) { next(error); }
}

export async function listAccountBalancesController(req, res, next){
    try{
        const { asOf } = balanceQuerySchema.parse(req.query);
        const data = await listAccountBalances({ tenantId: req.auth.tenantId, asOf });
        res.json({ data });
    }catch(error) { next(error); }
}