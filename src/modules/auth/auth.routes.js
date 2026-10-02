import { Router } from "express";
import { registerController, loginController } from "./auth.controller.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { env } from "../../config/env.js";

const router = Router();

// Keyed on IP and the attempted email, so one attacker can't lock out a user
// from every IP, and one IP can't spray many accounts.
const loginLimiter = rateLimit({
  name: "login",
  limit: env.RATE_LIMIT_LOGIN_PER_15MIN,
  windowSec: 15 * 60,
  key: (req) => `${req.ip}:${String(req.body?.email ?? "").trim().toLowerCase()}`,
});

const registerLimiter = rateLimit({
  name: "register",
  limit: env.RATE_LIMIT_REGISTER_PER_HOUR,
  windowSec: 60 * 60,
  key: (req) => req.ip,
});

router.post("/register", registerLimiter, registerController);
router.post("/login", loginLimiter, loginController);

export default router;
