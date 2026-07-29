import { Redis } from "ioredis";
import config from "../../config/index.js";
import logger from "../observability/logger.js";

let redis: Redis | null = null;

export function connectRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, {
      // Null = queue commands indefinitely while reconnecting rather than
      // throwing MaxRetriesPerRequestError and crashing the process.
      maxRetriesPerRequest: null,
      // Exponential back-off capped at 5 s; stops after 20 attempts so a
      // permanently-down Redis doesn't spin forever.
      retryStrategy(times: number) {
        if (times > 20) return null; // stop retrying
        return Math.min(times * 100, 5000);
      },
      // Don't try to run SUBSCRIBE/PUBLISH commands over a broken connection;
      // let them be queued until the connection recovers.
      enableOfflineQueue: true,
      // Suppress the "connect ECONNREFUSED" from crashing the process.
      lazyConnect: false,
    });

    redis.on("error", (err: Error) => {
      // Suppress repetitive connection-refused noise in dev.
      if (
        (err as NodeJS.ErrnoException).code === "ECONNREFUSED" ||
        err.message.includes("ECONNREFUSED")
      ) {
        logger.warn(
          { redisUrl: config.redisUrl },
          "Cannot connect to Redis — presence and real-time features will not work until Redis is started"
        );
      } else {
        logger.error({ err }, "Redis client error");
      }
    });

    redis.on("connect", () => logger.info({ redisUrl: config.redisUrl }, "Redis connected"));
    redis.on("ready", () => logger.info("Redis ready"));
    redis.on("close", () => logger.warn("Redis connection closed, reconnecting..."));
  }
  return redis;
}

export function getRedisClient(): Redis {
  if (!redis) return connectRedis();
  return redis;
}

/**
 * A fresh, standalone ioredis connection for callers that must not share a
 * connection with the rest of the app (e.g. BullMQ, which issues blocking
 * commands that would stall pub/sub or other traffic on a shared client).
 * Each call returns a new connection — callers own its lifecycle (`.quit()`).
 */
export function createDedicatedRedisConnection(): Redis {
  return new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    retryStrategy(times: number) {
      if (times > 20) return null;
      return Math.min(times * 100, 5000);
    },
  });
}
