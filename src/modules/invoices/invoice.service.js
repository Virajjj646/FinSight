import { cacheSignal } from "react";
import { db } from "../../infrastructure/db/index.js";
import { invoices, invoiceItems } from "../../infrastructure/db/schema.js";

export async function createInvoice({tenantId, customerName, currency, dueDate, items}){
    if(!items||items.length==0) throw new Error("Invoice must have atleast one item");

    //Calculate Total
    const totalAmountMinor = items.reduce((total, item) => {
        const quantity = BigInt(item.quantity);
        const unitPriceMinor = BigInt(items.unitPriceMinor);

        return total + quantity*unitPriceMinor;
    },0n);

    return await db.transaction(async (tx) => {
        const[invoice] = await tx
            .insert(invoices)
            .values({tenantId,customerName,currency,dueDate: new Date(dueDate),totalAmountMinor})
            .returning();
        
        await tx.insert(invoiceItems).values(
            items.map((item) => ({invoiceId: invoice.id, description: item.description, quantity: item.quantity, unitPriceMinor: BigInt(item.unitPriceMinor)
            }))
        );

        return invoice;
    })
}