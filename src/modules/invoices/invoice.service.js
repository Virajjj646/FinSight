import { db } from "../../infrastructure/db/index.js";
import { invoices, invoiceItems , invoicePayments, invoiceStatusHistory, journalEntries, accounts } from "../../infrastructure/db/schema.js";
import { and, eq, inArray , lt, desc, sql } from "drizzle-orm";
import { assertTransition, statusThatCanReach  } from "./invoice.state.js";
import { createJournalEntryTx } from "../ledger/ledger.service.js";
import { AppError } from "../../lib/AppError.js";
import crypto from "crypto";
import { fingerprint } from "../../lib/idempotency.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";

export async function createInvoice({tenantId, customerName, currency, dueDate, items}){
    if(!items||items.length==0) throw new AppError("Invoice must have atleast one item", 422, "INVALID_INVOICE");

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

export async function issueInvoice(invoiceId, tenantId) {
    return await db.transaction(async(tx) => {
        const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.id,invoiceId), eq(invoices.tenantId,tenantId))).limit(1);
        if(!invoice) throw new AppError("Invoice not found", 404, "NOT_FOUND");
        assertTransition(invoice.status, "ISSUED");

        const[updatedInvoice] = await tx
            .update(invoices)
            .set({status:"ISSUED", issueDate: new Date(), updatedAt: new Date() })
            .where(and(eq(invoices.id,invoiceId), eq(invoices.tenantId,tenantId)))
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
    invoiceId, tenantId, amountMinor, paidAt, bankAccountId, accountReceivableAccountId, idempotencyKey,
}){
    return await db.transaction(async (tx) => {

        //Find invoice, locked against concurrent payments
        const[invoice] = await tx
            .select().from(invoices)
            .where(and(eq(invoices.id,invoiceId), eq(invoices.tenantId,tenantId)))
            .for("update")
            .limit(1);
        if(!invoice) throw new AppError("Invoice not found", 404, "NOT_FOUND");

        const requestFingerprint = fingerprint({
            invoiceId,amountMinor,paidAt,bankAccountId,accountReceivableAccountId,
        });
        const effectivePaidAt = paidAt ? new Date(paidAt) : new Date();

        const [payment] = await tx
            .insert(invoicePayments)
            .values({invoiceId, tenantId, amountMinor, paidAt: effectivePaidAt, journalEntryId: null, idempotencyKey, requestFingerprint})
            .onConflictDoNothing({
                target: [invoicePayments.tenantId, invoicePayments.idempotencyKey],
            })
            .returning()

        if(!payment) return await replayPayment({tx,tenantId,idempotencyKey,requestFingerprint});

        const [bankAccount] = await tx.select().from(accounts)
            .where(and(eq(accounts.id, bankAccountId), eq(accounts.tenantId, tenantId))).limit(1);
        const [receivableAccount] = await tx.select().from(accounts)
            .where(and(eq(accounts.id, accountReceivableAccountId), eq(accounts.tenantId, tenantId))).limit(1);

        if(!bankAccount || !receivableAccount) throw new AppError("One or more accounts are invalid", 422, "INVALID_ACCOUNT");
        if(bankAccount.currency !== invoice.currency || receivableAccount.currency !== invoice.currency){
            throw new AppError("Payment accounts must match the invoice currency", 422, "CURRENCY_MISMATCH");
        }

        const allPayments = await tx.select().from(invoicePayments)
            .where(eq(invoicePayments.invoiceId, invoiceId));
        const paidAmountMinor = allPayments.reduce((t,p) => t + p.amountMinor, 0n);

        if(paidAmountMinor> invoice.totalAmountMinor) throw new AppError ("Payment exceeds remaining invoice amount", 422, "PAYMENT_EXCEEDS_REMAINING");

        const targetStatus = paidAmountMinor === invoice.totalAmountMinor ? "PAID" : "PARTIALLY_PAID";
        try {
            assertTransition(invoice.status, targetStatus);
        } catch {
            throw new AppError(
                `Cannot make payment on ${invoice.status} invoice`, 422, "NOT_PAYABLE"
            );
        }

        //Create ledger entry
        const { entry: journalEntry } = await createJournalEntryTx({
            tx,
            tenantId,
            idempotencyKey: `payment: ${payment.id}`,
            data: {
                description: `Payment for invoice ${invoice.invoiceNumber}`,
                occurredAt: effectivePaidAt,
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

        const [linkedPayment] = await tx.update(invoicePayments)
            .set({journalEntryId: journalEntry.id})
            .where(eq(invoicePayments.id, payment.id))
            .returning()

        if (targetStatus !== invoice.status) {
            await tx.insert(invoiceStatusHistory).values({
                invoiceId: invoice.id,
                fromStatus: invoice.status,
                toStatus: targetStatus,
                reason: "Payment received"
            });
        }

        //Update invoice
        const [updatedInvoice] = await tx
            .update(invoices)
            .set({status: targetStatus, updatedAt: new Date()})
            .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
            .returning();

        return{ payment: linkedPayment, invoice: updatedInvoice, journalEntry, replayed: false};
    });
}

export async function voidInvoice(invoiceId, tenantId){
    return await db.transaction(async (tx) =>{
        const [invoice] = await tx
            .select().from(invoices).where(and(eq(invoices.id,invoiceId), eq(invoices.tenantId,tenantId))).limit(1);

        if(!invoice) throw new AppError("Invoice not found", 404, "NOT_FOUND");
        assertTransition(invoice.status, "VOID");

        const [updatedInvoice] = await tx
            .update(invoices)
            .set({status: "VOID", updatedAt: new Date()})
            .where(and(eq(invoices.id,invoiceId), eq(invoices.tenantId,tenantId)))
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
        const overdueSources = statusThatCanReach("OVERDUE");
        const overdueCandidates = await tx
        .select().from(invoices)
        .where(and(
            inArray(invoices.status, overdueSources),
            lt(invoices.dueDate,now)
        ));

        const updatedInvoices = [];
        for(const invoice of overdueCandidates){
            const[updatedInvoice] = await tx
                .update(invoices)
                .set({status: "OVERDUE", updatedAt: now})
                .where(
                    and(
                        eq(invoices.id,invoice.id),
                        inArray(invoices.status, overdueSources)
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

async function replayPayment({ tx, tenantId, idempotencyKey, requestFingerprint}){
    const [existing] = await tx.select().from(invoicePayments)
        .where(and(
            eq(invoicePayments.tenantId, tenantId),
            eq(invoicePayments.idempotencyKey, idempotencyKey)
        ))
        .limit(1);

    if(existing.requestFingerprint !== requestFingerprint){
        throw new AppError(
            "This Idempotency-Key was already used with a different request body",
            409, "IDEMPOTENCY_KEY_REUSED",
        );
    }

    const [invoice] = await tx.select().from(invoices)
        .where(eq(invoices.id, existing.invoiceId)).limit(1);

    const [journalEntry] = existing.journalEntryId
        ? await tx.select().from(journalEntries).where(eq(journalEntries.id, existing.journalEntryId)).limit(1)
        : [null];

    return { payment: existing, invoice, journalEntry, replayed: true };
}

export async function listInvoices({ tenantId, limit, cursor, status, dueBefore}){
    const filters = [eq(invoices.tenantId, tenantId)];

    if(status) filters.push(inArray(invoices.status, status));
    if(dueBefore) filters.push(lt(invoices.dueDate, dueBefore));

    if(cursor){
        const decoded = decodeCursor(cursor);
        if(!decoded) throw new AppError("Invalid cursor", 400, "INVALID_CURSOR");
        filters.push(
            sql`(${invoices.createdAt}, ${invoices.id}) < (${decoded.occurredAt}, (${decoded.id}))`
        );
    }

    const rows = await db
        .select()
        .from(invoices)
        .where(and(...filters))
        .orderBy(desc(invoices.createdAt), desc(invoices.id))
        .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const paidByInvoice = new Map();
    if(page.length){
        const sums = await db
            .select({
                invoiceId: invoicePayments.invoiceId,
                paid: sql`COALESCE(SUM(${invoicePayments.amountMinor}), 0) ::text`,
            })
            .from(invoicePayments)
            .where(inArray(invoicePayments.invoiceId, page.map((i) => i.id)))
            .groupBy(invoicePayments.invoiceId);

        for( const row of sums) paidByInvoice.set(row.invoiceId, BigInt(row.paid));  
    }

    return{
        data: page.map((inv) => {
            const paid = paidByInvoice.get(inv.id) ?? 0n;
            return{
                ...inv,
                totalAmountMinor: inv.totalAmountMinor.toString(),
                paidAmountMinor: paid.toString(),
                outstandingMinor: (inv.totalAmountMinor - paid).toString()
            };
        }),
        nextCursor: hasMore ? encodeCursor({ occurredAt: page.at(-1).createdAt, id: page.at(-1).id}) : null
    };
}


export async function getInvoice({ tenantId, invoiceId}){
    const [ invoice ] = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id,invoiceId), eq(invoices.tenantId, tenantId)));

    if(!invoice) throw new AppError("Invoice not found", 404, "NOT_FOUND");

    const [items, payments, history] = await Promise.all([
        db.select().from(invoiceItems)
            .where(eq(invoiceItems.invoiceId, invoiceId)),
        db.select().from(invoicePayments)
            .where(eq(invoicePayments.invoiceId, invoiceId))
            .orderBy(desc(invoicePayments.createdAt)),
        db.select().from(invoiceStatusHistory)
            .where(eq(invoiceStatusHistory.invoiceId, invoiceId))
            .orderBy(desc(invoiceStatusHistory.changedAt)),
    ]);

    const paid = payments.reduce((sum,p) => sum + p.amountMinor, 0n);

    return{
        ...invoice,
        totalAmountMinor: invoice.totalAmountMinor.toString(),
        paidAmountMinor: paid.toString(),
        outstandingMinor: (invoice.totalAmountMinor - paid).toString(),
        items: items.map((i) => ({
            ...i,
            unitPriceMinor: i.unitPriceMinor.toString(),
            lineTotalMinor: (i.unitPriceMinor * BigInt(i.quantity)).toString(),
        })),
        payments: payments.map((p) => ({ ...p, amountMinor: p.amountMinor.toString()})),
        statusHistory: history,
    };
}