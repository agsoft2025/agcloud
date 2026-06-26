import { buildApp } from "./app.js";
import config from "./config/index.js";
import { connectMongo } from "./shared/db/mongo.client.js";
import { connectRedis } from "./shared/db/redis.client.js";
import { initRealtime } from "./modules/realtime/realtime.service.js";
import {
  startPresenceWorker,
  stopPresenceWorker,
  cleanupOnStartup,
} from "./modules/presence/presence.worker.js";

// Prevent any stray unhandled Redis / ioredis promise rejections from
// crashing the process.  Log them as errors instead.
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled promise rejection (process kept alive):", reason);
});

export async function startServer() {
  const app = await buildApp();

  try {
    await connectMongo();
    const redis = connectRedis();

    initRealtime(app.server);

    // Clean up stale Redis socket sets from a previous process, then evaluate
    // all presence records so dead connections are marked OFFLINE at boot.
    // If Redis is not yet available this is a no-op (cleanupOnStartup already
    // has a try/catch) and will self-heal once Redis comes online.
    await cleanupOnStartup();

    startPresenceWorker();

    await app.listen({ port: config.port, host: "0.0.0.0" });

    const signals: Array<"SIGINT" | "SIGTERM"> = ["SIGINT", "SIGTERM"];
    for (const signal of signals) {
      process.on(signal, async () => {
        app.log.info("Received " + signal + ", shutting down gracefully...");
        stopPresenceWorker();
        await redis.quit();
        await app.close();
        process.exit(0);
      });
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
