import { setupInvoiceSchedular } from "./infrastructure/queue/invoice.schedular.js";
import "./infrastructure/queue/invoice.worker.js";

console.log("FinSight worker started");

await setupInvoiceSchedular();