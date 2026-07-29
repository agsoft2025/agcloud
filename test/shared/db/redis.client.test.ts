import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

class FakeIORedis extends EventEmitter {
  constructor(
    public url: string,
    public options: unknown
  ) {
    super();
  }
}

const constructedWith: unknown[] = [];

class FakeRedisCtor extends FakeIORedis {
  constructor(url: string, options: unknown) {
    super(url, options);
    constructedWith.push({ url, options });
  }
}

vi.mock("ioredis", () => ({
  Redis: FakeRedisCtor,
}));

describe("shared/db/redis.client", () => {
  beforeEach(() => {
    vi.resetModules();
    constructedWith.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connectRedis constructs a single Redis instance and reuses it on subsequent calls", async () => {
    const { connectRedis } = await import("../../../src/shared/db/redis.client.js");
    const a = connectRedis();
    const b = connectRedis();

    expect(a).toBe(b);
    expect(constructedWith).toHaveLength(1);
  });

  it("getRedisClient lazily connects if not already connected, then reuses the same client", async () => {
    const { getRedisClient, connectRedis } = await import("../../../src/shared/db/redis.client.js");
    const viaGetter = getRedisClient();
    const viaConnect = connectRedis();
    const viaGetterAgain = getRedisClient(); // now-connected branch

    expect(viaGetter).toBe(viaConnect);
    expect(viaGetter).toBe(viaGetterAgain);
    expect(constructedWith).toHaveLength(1);
  });

  it("retryStrategy backs off linearly and gives up after 20 attempts", async () => {
    const { connectRedis } = await import("../../../src/shared/db/redis.client.js");
    const client = connectRedis() as unknown as FakeIORedis;
    const retryStrategy = (client.options as { retryStrategy: (times: number) => number | null })
      .retryStrategy;

    expect(retryStrategy(5)).toBe(500);
    expect(retryStrategy(20)).toBe(2000);
    expect(retryStrategy(21)).toBeNull();
  });

  it("logs a warning (not an error) for ECONNREFUSED, and an error for other failures", async () => {
    // logger.js must be imported fresh here (after vi.resetModules() in
    // beforeEach) so it's the SAME module instance redis.client.ts resolves
    // internally — spying on the test file's static top-level import would
    // silently spy on a different (stale) pino instance and never see calls.
    const { default: logger } = await import("../../../src/shared/observability/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);

    const { connectRedis } = await import("../../../src/shared/db/redis.client.js");
    const client = connectRedis() as unknown as FakeIORedis;

    const refusedErr = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), {
      code: "ECONNREFUSED",
    });
    client.emit("error", refusedErr);
    expect(warnSpy).toHaveBeenCalled();

    client.emit("error", new Error("some other redis failure"));
    expect(errorSpy).toHaveBeenCalled();
  });

  it("logs connect/ready/close lifecycle events without throwing", async () => {
    const { default: logger } = await import("../../../src/shared/observability/logger.js");
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const { connectRedis } = await import("../../../src/shared/db/redis.client.js");
    const client = connectRedis() as unknown as FakeIORedis;

    client.emit("connect");
    client.emit("ready");
    client.emit("close");

    expect(infoSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});
