import { buildApp } from "./app.js";
import config from "./config/index.js";
import { connectMongo, ensureIndexes, closeMongo } from "./shared/db/mongo.client.js";
import { connectRedis } from "./shared/db/redis.client.js";
import { initRealtime } from "./modules/realtime/realtime.service.js";
import {
  startPresenceWorker,
  stopPresenceWorker,
  cleanupOnStartup,
} from "./modules/presence/presence.worker.js";
import { startCallTimeoutWorker, stopCallTimeoutWorker } from "./modules/call/call.queue.js";
import { startPushFallbackWorker, stopPushFallbackWorker } from "./modules/notification/notification.queue.js";
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

// Spec §6.5: in-flight requests get at most 30s to finish draining once the
// HTTP server stops accepting new connections. Without this cap, a single
// hung request (or a client that never disconnects) would block shutdown
// forever instead of the process exiting within a bounded time.
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

export function withTimeout(promise: Promise<unknown>, ms: number, label: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn({ label, ms }, "Graceful shutdown step timed out — proceeding anyway");
      resolve();
    }, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err) => {
        clearTimeout(timer);
        logger.warn({ err, label }, "Graceful shutdown step failed — proceeding anyway");
        resolve();
      }
    );
  });
}

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
    startPushFallbackWorker();

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

        // 1. Stop accepting new connections and wait for in-flight requests
        //    to finish (bounded — see SHUTDOWN_DRAIN_TIMEOUT_MS). LiveKit/FCM/
        //    APNs have no persistent client to close (plain REST/fetch calls),
        //    so there's no separate step for them.
        await withTimeout(app.close(), SHUTDOWN_DRAIN_TIMEOUT_MS, "app.close");

        // 2. Background workers — safe to stop only once no more HTTP
        //    requests can schedule new work on them.
        stopPresenceWorker();
        await stopCallTimeoutWorker();
        await stopPushFallbackWorker();

        // 3. Disconnect MongoDB and Redis last, after everything that might
        //    still be using them has been drained/stopped.
        await redis.quit();
        await closeMongo();

        // pino here writes synchronously to stdout (no async transport
        // configured), so there is no separate log-flush step to await.
        process.exit(0);
      });
    }
  } catch (err) {
    logger.error({ err: serializeError(err) }, "Server startup failed");
    process.exit(1);
  }
}
