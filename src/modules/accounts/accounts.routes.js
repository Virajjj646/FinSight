import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { createAccountController, listAccountsController } from "./account.controller.js";

const router = Router();

router.use(authenticate);
router.post("/", createAccountController);
router.get("/", listAccountsController);

export default router