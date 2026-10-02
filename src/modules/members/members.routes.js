import { Router } from "express";
import { listMembersController, createMemberController } from "./member.controller.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireRole } from "../../middleware/requireRole.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { env } from "../../config/env.js";

const router = Router();

// Per tenant. Runs after requireRole, so rejected MEMBER attempts don't count.
const memberCreateLimiter = rateLimit({
  name: "member-create",
  limit: env.RATE_LIMIT_MEMBER_CREATE_PER_HOUR,
  windowSec: 60 * 60,
  key: (req) => req.auth.tenantId,
});

router.use(authenticate);

router.get("/", listMembersController);
router.post("/", requireRole("OWNER", "ADMIN"), memberCreateLimiter, createMemberController);

export default router;
