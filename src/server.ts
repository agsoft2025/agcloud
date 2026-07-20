import { buildApp } from "./app.js";
import config from "./config/index.js";
import { connectMongo, ensureIndexes } from "./shared/db/mongo.client.js";
import { connectRedis } from "./shared/db/redis.client.js";
import { initRealtime } from "./modules/realtime/realtime.service.js";
import {
  startPresenceWorker,
  stopPresenceWorker,
  cleanupOnStartup,
} from "./modules/presence/presence.worker.js";
import { startCallTimeoutWorker, stopCallTimeoutWorker } from "./modules/call/call.queue.js";
import logger from "./shared/observability/logger.js";

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
}

process.on("unhandledRejection", (reason) => {
  logger.error({ err: serializeError(reason) }, "Unhandled promise rejection - process kept alive");
});

export async function startServer() {
  try {
    const app = await buildApp();

    await connectMongo();
    await ensureIndexes();
    const redis = connectRedis();

    initRealtime(app.server);

    await cleanupOnStartup();
    startPresenceWorker();
    startCallTimeoutWorker();

    await app.listen({ port: config.port, host: "0.0.0.0" });
    logger.info(
      {
        port: config.port,
        host: "0.0.0.0",
        url: `http://localhost:${config.port}`,
      },
      "Backend server running"
    );

    const signals: Array<"SIGINT" | "SIGTERM"> = ["SIGINT", "SIGTERM"];
    for (const signal of signals) {
      process.on(signal, async () => {
        logger.info({ signal }, "Shutting down gracefully");
        stopPresenceWorker();
        await stopCallTimeoutWorker();
        await redis.quit();
        await app.close();
        process.exit(0);
      });
    }
  } catch (err) {
    logger.error({ err: serializeError(err) }, "Server startup failed");
    process.exit(1);
  }
}
