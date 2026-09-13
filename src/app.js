import express from "express";
import "dotenv/config";
import ledgerRoutes from "./modules/ledger/ledger.routes.js";
import invoiceRoutes from "./modules/invoices/invoice.routes.js";


const app = express();

app.use(express.json());

app.use("/api/ledger", ledgerRoutes);
app.use("/api/invoices", invoiceRoutes);

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "finsight-api"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`FinSight API running on port ${PORT}`);
});

