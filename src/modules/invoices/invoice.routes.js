import express from "express";
import { createInvoiceController, issueInvoiceController , createInvoicePaymentController, voidInvoiceController, listInvoicesController, getInvoiceController } from "./invoice.controller.js";
import { authenticate } from "../../middleware/authenticate.js";

const router = express.Router();

router.use(authenticate);

router.post("/", createInvoiceController );
router.post("/:id/issue", issueInvoiceController);
router.post("/:id/payments", createInvoicePaymentController);
router.post("/:id/void" , voidInvoiceController);
router.get("/" , listInvoicesController);
router.get("/:id", getInvoiceController);

export default router;