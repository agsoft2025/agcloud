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

/** Graceful-shutdown counterpart to connectMongo() — spec §6.5 requires MongoDB disconnected before process exit. */
export async function closeMongo(): Promise<void> {
  await client.close();
  db = null;
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
      // Supports the admin "active calls" listing: filter by status, sorted newest-first.
      calls.createIndex({ status: 1, createdAt: -1 }, { name: "status_history" }),
      calls.createIndex({ roomId: 1 }, { sparse: true, name: "room_id" }),
      calls.createIndex({ egressId: 1 }, { sparse: true, name: "egress_id" }),
      // Unique (not just a lookup index): DB-level guard against the "simultaneous
      // initiation" race (spec §10.2) — two concurrent POST /calls/initiate
      // requests from the same caller both pass the in-app "already in an
      // active call" read-then-write check before either insert lands. This
      // index makes the second insert fail instead of silently creating two
      // active calls for one caller; call.repository.ts's createCall() turns
      // that failure into the same "already in an active call" response.
      calls.createIndex(
        { callerId: 1, status: 1 },
        {
          name: "caller_active",
          unique: true,
          partialFilterExpression: { status: { $in: ["initiated", "active"] } },
        }
      ),
    ]);

    const devices = database.collection("devices");
    await Promise.all([
      devices.createIndex({ userId: 1 }, { name: "user_devices" }),
      devices.createIndex(
        { userId: 1, platform: 1, token: 1 },
        { unique: true, name: "device_unique" }
      ),
    ]);

    const refreshTokens = database.collection("refresh_tokens");
    await Promise.all([
      refreshTokens.createIndex({ jti: 1 }, { unique: true, name: "jti_unique" }),
      refreshTokens.createIndex({ familyId: 1 }, { name: "family_lookup" }),
      refreshTokens.createIndex({ userId: 1, revoked: 1 }, { name: "user_active_sessions" }),
      // TTL index — Mongo automatically deletes rotated-away/expired refresh
      // tokens once their expiresAt passes, so the collection doesn't grow
      // unbounded with dead rotation history.
      refreshTokens.createIndex({ expiresAt: 1 }, { name: "ttl_expiry", expireAfterSeconds: 0 }),
    ]);

    const auditLogs = database.collection("audit_logs");
    await Promise.all([
      auditLogs.createIndex({ userId: 1, createdAt: -1 }, { name: "user_history" }),
      auditLogs.createIndex({ event: 1, createdAt: -1 }, { name: "event_history" }),
    ]);

    const contacts = database.collection("contacts");
    await Promise.all([
      contacts.createIndex(
        { ownerId: 1, contactId: 1 },
        { unique: true, name: "owner_contact_unique" }
      ),
      contacts.createIndex({ contactId: 1 }, { name: "contact_watchers" }),
    ]);

    const blocks = database.collection("blocks");
    await Promise.all([
      blocks.createIndex(
        { blockerId: 1, blockedId: 1 },
        { unique: true, name: "blocker_blocked_unique" }
      ),
      blocks.createIndex({ blockedId: 1 }, { name: "blocked_lookup" }),
    ]);

    logger.info("MongoDB indexes ensured");
  } catch (err) {
    logger.warn({ err }, "MongoDB index creation failed (non-fatal)");
  }
}
