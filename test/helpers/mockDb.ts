import { vi } from "vitest";
import type { FakeDb } from "./fakeMongo.js";
import type { FakeRedis } from "./fakeRedis.js";

// Import this module (before importing anything that transitively pulls in
// mongo.client.js / redis.client.js) to have Mongo/Redis replaced with the
// in-memory fakes for the current test file. vi.mock registers the
// substitution before the real modules are ever loaded, so plain import
// order (this file first) is sufficient — no hoisting tricks needed.
vi.mock("../../src/shared/db/mongo.client.js", async () => {
  const { createFakeDb } = await import("./fakeMongo.js");
  const db = createFakeDb();
  (globalThis as any).__fakeDb = db;
  return {
    connectMongo: async () => db,
    getMongoClient: () => ({ db: () => db }),
    ensureIndexes: async () => {},
  };
});

vi.mock("../../src/shared/db/redis.client.js", async () => {
  const { createFakeRedis } = await import("./fakeRedis.js");
  const redis = createFakeRedis();
  (globalThis as any).__fakeRedis = redis;
  return {
    connectRedis: () => redis,
    getRedisClient: () => redis,
    // Callers (call.queue.ts's BullMQ Queue/Worker) that need an isolated
    // connection get a fresh fake each time, matching real dedicated-connection
    // semantics without touching the network. BullMQ itself is separately
    // mocked (see mockBullmq.ts) since a fake Redis doesn't implement the
    // Lua/stream commands BullMQ issues.
    createDedicatedRedisConnection: () => createFakeRedis(),
  };
});

// Force the mock factories above to run immediately (rather than lazily on
// first real import) so getFakeDb()/getFakeRedis() are populated as soon as
// this module is imported, even in tests that never transitively import the
// real mongo.client.js/redis.client.js (e.g. a repository-only unit test).
await import("../../src/shared/db/mongo.client.js");
await import("../../src/shared/db/redis.client.js");

export function getFakeDb(): FakeDb {
  return (globalThis as any).__fakeDb as FakeDb;
}

export function getFakeRedis(): FakeRedis {
  return (globalThis as any).__fakeRedis as FakeRedis;
}

export function resetFakes(): void {
  getFakeDb()?.reset();
  const redis = getFakeRedis();
  if (redis) {
    redis.strings.clear();
    redis.hashes.clear();
    redis.sets.clear();
    redis.expirations.clear();
    redis.published = [];
  }
}
