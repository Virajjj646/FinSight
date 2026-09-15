import express from "express";
import { createInvoiceController, issueInvoiceController , createInvoicePaymentController, voidInvoiceController } from "./invoice.controller.js";
import { authenticate } from "../../middleware/authenticate.js";

const router = express.Router();

router.use(authenticate);

router.post("/", createInvoiceController );
router.post("/:id/issue", issueInvoiceController);
router.post("/:id/payments", createInvoicePaymentController);
router.post("/:id/void" , voidInvoiceController);

export default router;