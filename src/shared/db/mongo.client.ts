import { MongoClient, Db } from "mongodb";
import config from "../../config/index.js";
import logger from "../observability/logger.js";

const client = new MongoClient(config.mongoUri);
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (!db) {
    await client.connect();
    db = client.db();
  }
  return db;
}

export function getMongoClient(): MongoClient {
  return client;
}

/**
 * Create all required indexes.
 * Safe to call on every startup — MongoDB skips indexes that already exist.
 */
export async function ensureIndexes(): Promise<void> {
  const database = await connectMongo();

  try {
    const users = database.collection("users");
    await Promise.all([
      users.createIndex({ email: 1 }, { unique: true, name: "email_unique" }),
      users.createIndex({ presenceStatus: 1 }, { name: "presence_status" }),
      users.createIndex({ resetPasswordToken: 1 }, { sparse: true, name: "reset_token" }),
    ]);

    const calls = database.collection("calls");
    await Promise.all([
      calls.createIndex({ callerId: 1, createdAt: -1 }, { name: "caller_history" }),
      calls.createIndex({ calleeId: 1, createdAt: -1 }, { name: "callee_history" }),
      calls.createIndex({ receiverIds: 1, createdAt: -1 }, { name: "receiver_history" }),
      calls.createIndex({ status: 1 }, { name: "call_status" }),
      calls.createIndex({ roomId: 1 }, { sparse: true, name: "room_id" }),
      calls.createIndex({ egressId: 1 }, { sparse: true, name: "egress_id" }),
      // Compound index for "active calls for a user"
      calls.createIndex(
        { callerId: 1, status: 1 },
        { name: "caller_active", partialFilterExpression: { status: { $in: ["initiated", "active"] } } }
      ),
    ]);

    const devices = database.collection("devices");
    await Promise.all([
      devices.createIndex({ userId: 1 }, { name: "user_devices" }),
      devices.createIndex({ userId: 1, platform: 1, token: 1 }, { unique: true, name: "device_unique" }),
    ]);

    logger.info("MongoDB indexes ensured");
  } catch (err) {
    logger.warn({ err }, "MongoDB index creation failed (non-fatal)");
  }
}
