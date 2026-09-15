import { db } from "../../infrastructure/db/index.js";
import { invoices, invoiceItems , invoicePayments, invoiceStatusHistory } from "../../infrastructure/db/schema.js";
import { and, eq, inArray , lt } from "drizzle-orm";
import { canTransition  } from "./invoice.state.js";
import { createJournalEntryTx } from "../ledger/ledger.service.js";
import crypto from "crypto";

export async function createInvoice({tenantId, customerName, currency, dueDate, items}){
    if(!items||items.length==0) throw new Error("Invoice must have atleast one item");

    //Calculate Total
    const totalAmountMinor = items.reduce((total, item) => {
        const quantity = BigInt(item.quantity);
        const unitPriceMinor = BigInt(item.unitPriceMinor);

        return total + quantity*unitPriceMinor;
    },0n);

    const invoiceNumber = `INV-${crypto.randomUUID()}`;

    return await db.transaction(async (tx) => {
        const[invoice] = await tx
            .insert(invoices)
            .values({tenantId, invoiceNumber, customerName, currency, dueDate: new Date(dueDate), totalAmountMinor})
            .returning();
        
        await tx.insert(invoiceItems).values(
            items.map((item) => ({invoiceId: invoice.id, description: item.description, quantity: item.quantity, unitPriceMinor: BigInt(item.unitPriceMinor)
            })),
        );

        await tx.insert(invoiceStatusHistory).values({
            invoiceId: invoice.id,
            fromStatus: null,
            toStatus: "DRAFT",
            reason: "Invoice created"
        
        });

        return invoice;
    })
}

export async function issueInvoice(invoiceId) {
    return await db.transaction(async(tx) => {
        const [invoice] = await tx.select().from(invoices).where(eq(invoices.id,invoiceId)).limit(1);
        if(!invoice) throw new Error("Invoice not found");
        if(!canTransition(invoice.status, "ISSUED")) throw new Error(`Cannot transition invoice from ${invoice.status} to ISSUED`);
    
        const[updatedInvoice] = await tx
            .update(invoices)
            .set({status:"ISSUED", issueDate: new Date(), updtedAt: new Date() })
            .where(eq(invoices.id,invoiceId))
            .returning();

        await tx.insert(invoiceStatusHistory).values({
            invoiceId: invoice.id,
            fromStatus: invoice.status,
            toStatus: "ISSUED",
            reason: "Invoice issued"
        });
        return updatedInvoice;
    }); 
}

export async function createInvoicePayment({
    invoiceId, amountMinor, paidAt, bankAccountId, accountReceivableAccountId
}){
    return await db.transaction(async (tx) => {

        //Find invoice
        const[invoice] = await tx
            .select().from(invoices).where(eq(invoices.id,invoiceId)).limit(1);
        if(!invoice) throw new Error("Invoice not found");

        if(invoice.status == "PAID" || invoice.status == "VOID") throw new Error(`Cannot make payment on ${invoice.status} invoice`);
        
        //Find paid amount and calclate remaining amount
        const payments = await tx
            .select().from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId));
        
        const paidAmountMinor = payments.reduce(
            (total, payment) => total+payment.amountMinor,0n
        );

        const remainingAmountMinor = invoice.totalAmountMinor - paidAmountMinor;

        if(amountMinor > remainingAmountMinor) throw new Error("Payment exceeds remaining invoice amount");

        //Create ledger entry
        const journalEntry = await createJournalEntryTx({
            tx,
            tenantId: invoice.tenantId,
            idempotencyKey: `invoice-payment-${invoice.id}-${Date.now()}`,
            data: {
                description: `Payment for invoice ${invoice.invoiceNumber}`,
                occurredAt: paidAt,
                lines: [
                    {
                        accountId: bankAccountId,
                        amountMinor
                    },
                    {
                        accountId: accountReceivableAccountId,
                        amountMinor: -amountMinor
                    }
                ]
            }
        });

        //Create payment record
        const [payment] = await tx
            .insert(invoicePayments)
            .values({invoiceId, amountMinor, paidAt, journalEntryId: journalEntry.id})
            .returning()

        
        //Calculate new status
        const newPaidAmount = paidAmountMinor + amountMinor;
        const newStatus = newPaidAmount === invoice.totalAmountMinor? "PAID":"PARTIALLY_PAID";

        if (newStatus !== invoice.status) {
            await tx.insert(invoiceStatusHistory).values({
                invoiceId: invoice.id,
                fromStatus: invoice.status,
                toStatus: newStatus,
                reason: "Payment received"
            });
        }

        //Update invoice
        const [updatedInvoice] = await tx
            .update(invoices)
            .set({status: newStatus, updatedAt: new Date()})
            .where(eq(invoices.id, invoiceId))
            .returning();
        
        return{ payment, invoice: updatedInvoice, journalEntry};
    });
}

export async function voidInvoice(invoiceId){
    return await db.transaction(async (tx) =>{
        const [invoice] = await tx
            .select().from(invoices).where(eq(invoiceId,invoices.id)).limit(1);
        
        if(!invoice) throw new Error("Invoice not found");
        if(!canTransition(invoice.status,"VOID")) throw new Error(`Cannot transition invoice from ${invoice.status} to VOID`);

        const [updatedInvoice] = await tx
            .update(invoices)
            .set({status: "VOID", updtedAt: new Date()})
            .where(eq(invoices.id,invoiceId))
            .returning();
        
        await tx.insert(invoiceStatusHistory).values({
            invoiceId: invoice.id,
            fromStatus: invoice.status,
            toStatus: "VOID",
            reason: "Invoice voided"
        });

        return updatedInvoice;
    });
}

export async function markOverdueInvoices(){
    const now = new Date();
    return await db.transaction(async (tx) => {
        const overdueCandidates = await tx
        .select().from(invoices)
        .where(and(
            inArray(invoices.status, ["ISSUED","PARTIALLY_PAID"]),
            lt(invoices.dueDate,now)
        ));

        const updatedInvoices = [];
        for(const invoice of overdueCandidates){
            const[updatedInvoice] = await tx
                .update(invoices)
                .set({status: "OVERDUE", updtedAt: now})
                .where(
                    and(
                        eq(invoices.id,invoice.id),
                        inArray(invoice.status, ["ISSUED","PARTIALLY_PAID"])
                    )
                )
                .returning();
            
            if(!updatedInvoice) continue;

            await tx
                .insert(invoiceStatusHistory)
                .values({
                    invoiceId: invoice.id,
                    fromStatus: invoice.status,
                    toStatus: "OVERDUE",
                    reason: "Invoice due date passed"
                });
            updatedInvoices.push(updatedInvoice);
        }
        return updatedInvoices;
    });
}