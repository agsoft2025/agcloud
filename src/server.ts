import { buildApp } from "./app.js";
import config from "./config/index.js";
import { connectMongo } from "./shared/db/mongo.client.js";
import { connectRedis } from "./shared/db/redis.client.js";

export async function startServer() {
  const app = await buildApp();

  try {
    // Initialize database connections
    await connectMongo();
    const redis = connectRedis();

    await app.listen({ port: config.port, host: "0.0.0.0" });
    
    // Graceful shutdown handling
    const listeners = ["SIGINT", "SIGTERM"];
    for (const signal of listeners) {
      process.on(signal, async () => {
        app.log.info(`Received ${signal}, shutting down gracefully...`);
        
        // Close database connections
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
