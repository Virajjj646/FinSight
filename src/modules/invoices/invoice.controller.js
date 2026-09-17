import { createInvoiceSchema } from "./invoice.schema.js";
import { createInvoice , issueInvoice, createInvoicePayment, voidInvoice} from "./invoice.service.js";
import { createInvoicePaymentSchema } from "./invoice.payment.schema.js";
import { idempotencyKeySchema } from "../../lib/idempotency.js";

export async function createInvoiceController(req,res, next){
    try{
        const data = createInvoiceSchema.parse(req.body);
        const invoice = await createInvoice({ ...data, tenantId: req.auth.tenantId });
        res.status(201).json({
            ...invoice, totalAmountMinor: invoice.totalAmountMinor.toString()
        });
    }catch(error){
        next(error);
    }
}

export async function issueInvoiceController(req,res, next){
    try{
        const invoice = await issueInvoice(req.params.id, req.auth.tenantId);
        res.status(200).json({
            ...invoice, totalAmountMinor: invoice.totalAmountMinor.toString()
        });
    }catch(error){
        next(error);
    }
}

export async function createInvoicePaymentController(req, res, next){
    try{

        const idempotencyKey = idempotencyKeySchema.parse(req.header("Idempotency-Key"));
        const data = createInvoicePaymentSchema.parse(req.body);
        const { payment, invoice, journalEntry, replayed} = await createInvoicePayment({invoiceId: req.params.id, tenantId: req.auth.tenantId, idempotencyKey, ...data});
        res.status(replayed? 200 : 201).json({
            payment: { ...payment, amountMinor: payment.amountMinor.toString() },
            invoice: { ...invoice, totalAmountMinor: invoice.totalAmountMinor.toString() },
            journalEntry
        });
    }catch(error){
        next(error);
    }
}

export async function voidInvoiceController(req, res, next){
    try{
        const invoice = await voidInvoice(req.params.id, req.auth.tenantId);
        res.status(200).json({
            ...invoice, totalAmountMinor:invoice.totalAmountMinor.toString()
        });
    }catch(error){next(error);}
}