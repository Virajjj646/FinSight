import { Router } from "express";
import { createJournalEntryController } from "./ledger.controller.js";

const router = Router();

router.post("/entries",createJournalEntryController);
export default router;