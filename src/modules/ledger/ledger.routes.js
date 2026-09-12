import { Router } from "express";
import { creatwJournalEntryController } from "./ledger.controller.js";

const router = Router();

router.post("/entries",creatwJournalEntryController);
export default router;