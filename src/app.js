import { testDatabaseConnection } from "./infrastructure/db/index.js";

testDatabaseConnection().catch((error) => {
  console.error("DATABASE CONNECTION FAILED:");
  console.error(error);
});

import express from "express";
import "dotenv/config";

import { db } from "./infrastructure/db/index.js";
import { users } from "./infrastructure/db/schema.js";
import ledgerRoutes from "./modules/ledger/ledger.routes.js";

import { tenants, accounts } from "./infrastructure/db/schema.js";

const app = express();

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "finsight-api"
  });
});

app.post("/test-account", async (req, res) => {
  const result = await db
    .insert(accounts)
    .values({
      tenantId: req.body.tenantId,
      name: req.body.name,
      type: req.body.type,
      currency: req.body.currency
    })
    .returning();

  res.status(201).json(result);
});

app.post("/test-tenant", async (req, res) => {
  try {
    const result = await db
      .insert(tenants)
      .values({
        name: req.body.name
      })
      .returning();

    res.status(201).json(result);

  } catch (error) {
    console.error("DATABASE ERROR:");
    console.error(error);

    res.status(500).json({
      error: error.message,
      cause: error.cause?.message,
      code: error.code
    });
  }
});


app.use("/ledger", ledgerRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`FinSight API running on port ${PORT}`);
});

