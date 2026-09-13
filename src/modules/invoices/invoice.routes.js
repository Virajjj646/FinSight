import express from "express";
import { createInvoiceController, issueInvoiceController , createInvoicePaymentController, voidInvoiceController } from "./invoice.controller.js";

const router = express.Router();

router.post("/", createInvoiceController );
router.post("/:id/issue", issueInvoiceController);
router.post("/:id/payments", createInvoicePaymentController);
router.post("/:id/void" , voidInvoiceController);

export default router;