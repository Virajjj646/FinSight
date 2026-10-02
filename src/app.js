import express from "express";
import ledgerRoutes from "./modules/ledger/ledger.routes.js";
import invoiceRoutes from "./modules/invoices/invoice.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import accountRoutes from "./modules/accounts/accounts.routes.js";
import documentRoutes from "./modules/documents/documents.routes.js"
import adminRoutes from "./modules/admin/admin.routes.js";
import askRoutes from './modules/ask/ask.routes.js'
import memberRoutes from "./modules/members/members.routes.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { AppError } from "./lib/AppError.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { isShuttingDown } from "./lib/shutdown.js";
import { securityHeaders, cors } from "./middleware/securityHeaders.js";
import { env } from "./config/env.js";

const app = express();

app.disable("x-powered-by");
app.use(requestLogger);
app.use(securityHeaders);
app.use(cors({ origins: env.CORS_ORIGINS }));
app.use((req, res, next) => {
  if (isShuttingDown()) {
    res.setHeader("Connection", "close");
  }
  next();
});
app.use(express.json({ limit: "100kb" }));

app.use("/api/auth", authRoutes);
app.use("/api/ledger", ledgerRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/accounts", accountRoutes);
app.use('/api/documents', documentRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/ask" , askRoutes);
app.use("/api/members", memberRoutes);

app.get("/health", (req, res) => {
  if (isShuttingDown()) {
    return res.status(503).json({ status: "draining" });
  }
  res.json({
    status: "ok",
    service: "finsight-api"
  });
});

app.use((req, res, next) => {
  next(new AppError("Not found", 404, "NOT_FOUND"));
});

app.use(errorHandler);

export default app;

