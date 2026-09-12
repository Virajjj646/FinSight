import express from "express";
import "dotenv/config";

import { db } from "./infrastructure/db/index.js";
import { users } from "./infrastructure/db/schema.js";
import ledgerRoutes from "./modules/ledger/ledger.routes.js";

const app = express();

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "finsight-api"
  });
});

app.use("/ledger", ledgerRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`FinSight API running on port ${PORT}`);
});
