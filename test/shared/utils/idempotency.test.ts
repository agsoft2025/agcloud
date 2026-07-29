import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { getFakeRedis, resetFakes } from "../../helpers/mockDb.js";
import { idempotency, withIdempotency, isFirstDeliveryOfEvent } from "../../../src/shared/utils/idempotency.js";

describe("idempotency", () => {
  beforeEach(() => {
    resetFakes();
  });

  describe("idempotency.get/.set", () => {
    it("round-trips a record through redis", async () => {
      await idempotency.set("key-1", { status: 201, body: { ok: true } });
      const cached = await idempotency.get("key-1");
      expect(cached).toEqual({ status: 201, body: { ok: true } });
    });

    it("returns null when there is no cached record", async () => {
      const cached = await idempotency.get("missing-key");
      expect(cached).toBeNull();
    });

    it("get soft-fails (returns null) when redis throws", async () => {
      vi.spyOn(getFakeRedis(), "get").mockRejectedValueOnce(new Error("redis down"));
      const cached = await idempotency.get("key-1");
      expect(cached).toBeNull();
    });

    it("set soft-fails (does not throw) when redis throws", async () => {
      vi.spyOn(getFakeRedis(), "set").mockRejectedValueOnce(new Error("redis down"));
      await expect(idempotency.set("key-1", { status: 200, body: {} })).resolves.toBeUndefined();
    });
  });

  describe("isFirstDeliveryOfEvent (spec §6.2 webhook dedup)", () => {
    it("returns true the first time an event id is seen", async () => {
      expect(await isFirstDeliveryOfEvent("evt-1")).toBe(true);
    });

    it("returns false on a repeat delivery of the same event id", async () => {
      await isFirstDeliveryOfEvent("evt-1");
      expect(await isFirstDeliveryOfEvent("evt-1")).toBe(false);
    });

    it("treats different event ids independently", async () => {
      expect(await isFirstDeliveryOfEvent("evt-a")).toBe(true);
      expect(await isFirstDeliveryOfEvent("evt-b")).toBe(true);
    });

    it("fails open (returns true) when redis throws", async () => {
      vi.spyOn(getFakeRedis(), "set").mockRejectedValueOnce(new Error("redis down"));
      expect(await isFirstDeliveryOfEvent("evt-1")).toBe(true);
    });
  });

  describe("withIdempotency", () => {
    let app: FastifyInstance;
    let handler: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      handler = vi.fn(async (_request, reply) => {
        return reply.status(201).send({ created: true, at: Date.now() });
      });

      app = Fastify();
      app.post("/thing", withIdempotency(handler));
    });

    afterEach(async () => {
      await app.close();
    });

    it("executes the handler and caches the response on first call", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/thing",
        headers: { "idempotency-key": "abc-123" },
      });
      expect(response.statusCode).toBe(201);
      expect(handler).toHaveBeenCalledTimes(1);

      const cached = await idempotency.get("abc-123");
      expect(cached?.status).toBe(201);
      expect((cached?.body as any).created).toBe(true);
    });

    it("returns the cached response on a repeat call without re-invoking the handler", async () => {
      const first = await app.inject({
        method: "POST",
        url: "/thing",
        headers: { "idempotency-key": "abc-123" },
      });
      const second = await app.inject({
        method: "POST",
        url: "/thing",
        headers: { "idempotency-key": "abc-123" },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(second.statusCode).toBe(201);
      expect(JSON.parse(second.payload)).toEqual(JSON.parse(first.payload));
    });

    it("invokes the handler again for a different idempotency key", async () => {
      await app.inject({ method: "POST", url: "/thing", headers: { "idempotency-key": "key-a" } });
      await app.inject({ method: "POST", url: "/thing", headers: { "idempotency-key": "key-b" } });
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("invokes the handler every time when no idempotency key is provided", async () => {
      await app.inject({ method: "POST", url: "/thing" });
      await app.inject({ method: "POST", url: "/thing" });
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("does not cache a response with statusCode >= 500", async () => {
      const failingHandler = vi.fn(async (_request, reply) => {
        return reply.status(500).send({ error: "boom" });
      });
      const failApp = Fastify();
      failApp.post("/fail", withIdempotency(failingHandler));

      await failApp.inject({
        method: "POST",
        url: "/fail",
        headers: { "idempotency-key": "fail-key" },
      });

      const cached = await idempotency.get("fail-key");
      expect(cached).toBeNull();

      await failApp.inject({
        method: "POST",
        url: "/fail",
        headers: { "idempotency-key": "fail-key" },
      });
      expect(failingHandler).toHaveBeenCalledTimes(2);

      await failApp.close();
    });
  });
});
