import { db } from "./infrastructure/db/index.js";

const result = await db.execute("SELECT NOW()");

console.log("Database connected!");
console.log(result);