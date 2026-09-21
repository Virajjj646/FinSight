import { env } from "./config/env.js";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { registerShutdown } from "./lib/shutdown.js";
import { pool } from "./infrastructure/db/index.js";

const server = app.listen(env.PORT, () => {
  logger.info("server started", { port: env.PORT });
});

registerShutdown([
  [
    "http",
    () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeIdleConnections();
      }),
  ],
  ["postgres", () => pool.end()],
]);
