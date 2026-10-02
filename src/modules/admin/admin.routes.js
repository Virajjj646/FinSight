import express from "express";
import { markOverdueController } from "./admin.controller.js";
import { requireAdminToken } from "../../middleware/requireAdminToken.js";

const router = express.Router();

router.use(requireAdminToken);

router.post("/invoices/mark-overdue", markOverdueController);

export default router;
