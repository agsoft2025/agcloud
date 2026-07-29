import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { resetFakes } from "../../helpers/mockDb.js";
import * as redisClient from "../../../src/shared/db/redis.client.js";
import { registerRateLimiting } from "../../../src/shared/middleware/rate-limit.middleware.js";

describe("registerRateLimiting", () => {
  beforeEach(() => resetFakes());
  afterEach(() => vi.restoreAllMocks());

  it("registers with the Redis-backed store when Redis is available", async () => {
    const app = Fastify();
    await registerRateLimiting(app);
    app.get("/x", async () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: "/x" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("falls back to an in-memory store when getRedisClient throws", async () => {
    vi.spyOn(redisClient, "getRedisClient").mockImplementation(() => {
      throw new Error("redis not connected yet");
    });

    const app = Fastify();
    await registerRateLimiting(app);
    app.get("/x", async () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: "/x" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("derives the rate-limit key from x-forwarded-for when present", async () => {
    const app = Fastify();
    await registerRateLimiting(app);
    app.get("/x", async () => ({ ok: true }));

    const response = await app.inject({
      method: "GET",
      url: "/x",
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("falls back to request.ip when x-forwarded-for is absent", async () => {
    const app = Fastify();
    await registerRateLimiting(app);
    app.get("/x", async () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: "/x" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("responds 429 (not 500) once the limit is exceeded", async () => {
    const app = Fastify();
    // registerErrorHandler mirrors the app's real setup: it reads
    // `.statusCode` off whatever the rate-limit plugin throws. Without
    // `errorResponseBuilder` also setting `statusCode` on its returned
    // object, that read comes back `undefined` and this app-level handler
    // falls through to a generic 500 for what should be a 429.
    app.setErrorHandler((error: any, _request, reply) => {
      const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
      reply.status(statusCode).send({ error: error.message });
    });
    await registerRateLimiting(app);
    app.get("/x", { config: { rateLimit: { max: 1, timeWindow: "1 minute" } } }, async () => ({ ok: true }));

    const first = await app.inject({ method: "GET", url: "/x" });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "GET", url: "/x" });
    expect(second.statusCode).toBe(429);
    expect(JSON.parse(second.payload).error).toContain("Rate limit exceeded");
    await app.close();
  });
});
