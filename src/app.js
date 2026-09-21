import express from "express";
import ledgerRoutes from "./modules/ledger/ledger.routes.js";
import invoiceRoutes from "./modules/invoices/invoice.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import accountRoutes from "./modules/accounts/accounts.routes.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { AppError } from "./lib/AppError.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { isShuttingDown } from "./lib/shutdown.js";

const app = express();

app.use(requestLogger);
app.use((req, res, next) => {
  if (isShuttingDown()) {
    res.setHeader("Connection", "close");
  }
  next();
});
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/ledger", ledgerRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/accounts", accountRoutes);

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

