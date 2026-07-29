import { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { getRedisClient } from "../db/redis.client.js";

export async function registerRateLimiting(app: FastifyInstance): Promise<void> {
  let redis: any;
  try {
    redis = getRedisClient();
  } catch {
    // Redis not yet connected - rate limiter will use in-memory store
  }

  await app.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: "1 minute",
    ...(redis ? { redis } : {}),
    keyGenerator: (request) =>
      (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? request.ip,
    // @fastify/rate-limit does `throw errorResponseBuilder(...)` — the thrown
    // value must carry `statusCode` itself (its default builder returns an
    // Error with .statusCode set) or the app's generic error handler can't
    // tell it apart from an unhandled failure and reports 500 instead of 429.
    errorResponseBuilder: (_request: any, context: any) => ({
      statusCode: context.statusCode,
      error: "Too Many Requests",
      message: `Rate limit exceeded. Retry after ${context.after}.`,
      retryAfter: context.after,
    }),
  });
}
