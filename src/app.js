import { env } from "./config/env.js";
import express from "express";
import ledgerRoutes from "./modules/ledger/ledger.routes.js";
import invoiceRoutes from "./modules/invoices/invoice.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import accountRoutes from "./modules/accounts/accounts.routes.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { AppError } from "./lib/AppError.js";
import { requestId } from "./middleware/requestId.js";
import { requestLogger } from "./middleware/requestLogger.js";


const app = express();

app.use(requestId);
app.use(express.json());
app.use(requestLogger);
app.use("/api/auth", authRoutes);
app.use("/api/ledger", ledgerRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/accounts", accountRoutes);

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "finsight-api"
  });
});

app.use((req, res, next) => {
  next(new AppError("Not found", 404, "NOT_FOUND"));
});

app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`FinSight API running on port ${env.PORT}`);
});

