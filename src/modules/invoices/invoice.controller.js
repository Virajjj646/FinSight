import { createInvoiceSchema } from "./invoice.schema.js";
import { createInvoice , issueInvoice, createInvoicePayment, voidInvoice} from "./invoice.service.js";
import { createInvoicePaymentSchema } from "./invoice.payment.schema.js";

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
        const data = createInvoicePaymentSchema.parse(req.body);
        const result = await createInvoicePayment({invoiceId: req.params.id, tenantId: req.auth.tenantId, ...data});
        res.status(201).json({
            ...result,
            payment: { ...result.payment, amountMinor: result.payment.amountMinor.toString() },
            invoice: { ...result.invoice, totalAmountMinor: result.invoice.totalAmountMinor.toString() }
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