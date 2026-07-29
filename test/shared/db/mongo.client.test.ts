import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connectMock = vi.fn().mockResolvedValue(undefined);
const closeMock = vi.fn().mockResolvedValue(undefined);
const createIndexMock = vi.fn().mockResolvedValue("index_name");
const collectionMock = vi.fn(() => ({ createIndex: createIndexMock }));
const dbMock = vi.fn(() => ({ collection: collectionMock }));

class FakeMongoClient {
  connect = connectMock;
  close = closeMock;
  db = dbMock;
}

vi.mock("mongodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mongodb")>();
  return {
    ...actual,
    MongoClient: FakeMongoClient,
  };
});

describe("shared/db/mongo.client", () => {
  beforeEach(() => {
    vi.resetModules();
    connectMock.mockClear();
    closeMock.mockClear();
    createIndexMock.mockClear();
    collectionMock.mockClear();
    dbMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connectMongo connects once and caches the Db handle", async () => {
    const { connectMongo } = await import("../../../src/shared/db/mongo.client.js");
    const db1 = await connectMongo();
    const db2 = await connectMongo();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(db1).toBe(db2);
  });

  it("getMongoClient returns the underlying MongoClient instance", async () => {
    const { getMongoClient } = await import("../../../src/shared/db/mongo.client.js");
    const client = getMongoClient();
    expect(client).toBeDefined();
    expect(typeof client.connect).toBe("function");
  });

  it("ensureIndexes creates indexes on every expected collection", async () => {
    const { ensureIndexes } = await import("../../../src/shared/db/mongo.client.js");
    await ensureIndexes();

    const collectionNames = collectionMock.mock.calls.map((c) => c[0]);
    expect(collectionNames).toEqual(
      expect.arrayContaining(["users", "calls", "devices", "refresh_tokens", "audit_logs"])
    );
    expect(createIndexMock).toHaveBeenCalled();
  });

  it("ensureIndexes swallows index-creation errors without throwing", async () => {
    createIndexMock.mockRejectedValueOnce(new Error("index conflict"));
    const { ensureIndexes } = await import("../../../src/shared/db/mongo.client.js");
    await expect(ensureIndexes()).resolves.toBeUndefined();
  });

  it("closeMongo closes the underlying client", async () => {
    const { connectMongo, closeMongo } = await import("../../../src/shared/db/mongo.client.js");
    await connectMongo();
    await closeMongo();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("closeMongo lets a subsequent connectMongo reconnect (cached db handle is cleared)", async () => {
    const { connectMongo, closeMongo } = await import("../../../src/shared/db/mongo.client.js");
    await connectMongo();
    await closeMongo();
    await connectMongo();
    expect(connectMock).toHaveBeenCalledTimes(2);
  });
});
