/**
 * Idempotency key middleware for mutating HTTP endpoints.
 *
 * Usage in a route:
 *   const key = request.headers["idempotency-key"] as string | undefined;
 *   if (key) {
 *     const cached = await idempotency.get(key);
 *     if (cached) return reply.status(cached.status).send(cached.body);
 *   }
 *   // ... process the request ...
 *   if (key) await idempotency.set(key, { status: 201, body: result });
 */

import { getRedisClient } from "../db/redis.client.js";
import logger from "../observability/logger.js";

export interface IdempotencyRecord {
  status: number;
  body: unknown;
}

const TTL_SECONDS = 86_400; // 24 h

/**
 * Spec §6.2: "Webhook handlers | Event ID dedup in Redis (24h)". Distinct
 * from the client-driven Idempotency-Key flow below — a webhook provider
 * (LiveKit) redelivers the same event on timeout/5xx, so this is a
 * see-it-once guard keyed by the event's own id, not a response cache.
 *
 * Returns true the first time an id is seen (caller should process the
 * event), false on a repeat delivery (caller should skip it). Fails open
 * (returns true — process it) on a Redis error, since dropping a webhook
 * outright is worse than the small chance of double-processing during an
 * outage.
 */
export async function isFirstDeliveryOfEvent(eventId: string): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const result = await redis.set(`idempotency:webhook:${eventId}`, "1", "EX", TTL_SECONDS, "NX");
    return result === "OK";
  } catch (err) {
    logger.warn({ err, eventId }, "Webhook dedup check failed — processing the event anyway");
    return true;
  }
}

export const idempotency = {
  async get(key: string): Promise<IdempotencyRecord | null> {
    try {
      const redis = getRedisClient();
      const raw = await redis.get(`idempotency:${key}`);
      if (!raw) return null;
      return JSON.parse(raw) as IdempotencyRecord;
    } catch (err) {
      logger.warn({ err, key }, "Idempotency cache read failed");
      return null;
    }
  },

  async set(key: string, record: IdempotencyRecord): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.set(`idempotency:${key}`, JSON.stringify(record), "EX", TTL_SECONDS);
    } catch (err) {
      logger.warn({ err, key }, "Idempotency cache write failed");
    }
  },
};

/**
 * Wrap a Fastify route handler with idempotency logic.
 * Reads `Idempotency-Key` header; returns cached response if present.
 *
 * @example
 *   app.post("/calls/initiate", { preHandler: authenticate }, withIdempotency(async (request, reply) => { ... }));
 */
import { FastifyRequest, FastifyReply } from "fastify";

export function withIdempotency(
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const key = request.headers["idempotency-key"] as string | undefined;

    if (key) {
      const cached = await idempotency.get(key);
      if (cached) {
        logger.debug({ key }, "Idempotency cache hit — returning cached response");
        return reply.status(cached.status).send(cached.body);
      }
    }

    const originalSend = reply.send.bind(reply);
    let capturedStatus = 200;
    let capturedBody: unknown;

    // Monkey-patch send so we can capture the response for caching
    (reply as any).send = (payload: unknown) => {
      capturedStatus = reply.statusCode;
      capturedBody = payload;
      return originalSend(payload);
    };

    const result = await handler(request, reply);

    if (key && capturedBody !== undefined && capturedStatus < 500) {
      await idempotency.set(key, { status: capturedStatus, body: capturedBody });
    }

    return result;
  };
}
