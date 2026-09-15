import { Router } from "express";
import { createJournalEntryController } from "./ledger.controller.js";
import { authenticate } from "../../middleware/authenticate.js";

const router = Router();

router.use(authenticate);

router.post("/entries",createJournalEntryController);
export default router;