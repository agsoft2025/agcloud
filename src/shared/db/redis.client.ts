import { Redis } from "ioredis";
import config from "../../config/index.js";

let redis: Redis | null = null;

export function connectRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        return Math.min(times * 50, 2000);
      }
    });

    let hasLoggedError = false;
    redis.on("error", (err) => {
      if (config.env === "production") {
        console.error("Redis Error:", err);
      } else if (!hasLoggedError) {
        console.warn("Redis is unreachable. Some features (presence, active calls) may not work.");
        hasLoggedError = true;
      }
    });

    redis.on("connect", () => {
      console.log("Connected to Redis");
    });
  }
  return redis;
}

export function getRedisClient(): Redis {
  if (!redis) {
    return connectRedis();
  }
  return redis;
}
