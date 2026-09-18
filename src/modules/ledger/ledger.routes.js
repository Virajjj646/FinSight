import { Router } from "express";
import { createJournalEntryController, getAccountBalanceController, listEntriesController } from "./ledger.controller.js";
import { authenticate } from "../../middleware/authenticate.js";

const router = Router();

router.use(authenticate);

router.post("/entries",createJournalEntryController);
router.get("/entries", listEntriesController);
router.get("/accounts/:accountId/balance", getAccountBalanceController);
export default router;