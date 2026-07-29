/**
 * Security audit trail.
 *
 * Distinct from the application logger (`observability/logger.ts`): audit
 * entries are a durable, queryable forensic record of security-relevant
 * events (auth, session, and access-control decisions) — kept in MongoDB
 * indefinitely rather than rotated/shipped like ordinary log lines, and
 * structured for querying by user or event type rather than for grepping.
 *
 * Writes are fire-and-forget: a failure to write an audit entry must never
 * block or fail the request that triggered it. Failures are reported to the
 * regular logger so they're still visible to on-call engineers.
 */

import { ObjectId } from "mongodb";
import { connectMongo } from "../db/mongo.client.js";
import logger from "../observability/logger.js";

export type AuditSeverity = "info" | "warning" | "critical";

export type AuditEvent =
  | "auth.signup"
  | "auth.signin.success"
  | "auth.signin.failed"
  | "auth.signout"
  | "auth.logout_all"
  | "auth.refresh.success"
  | "auth.refresh.invalid"
  | "auth.refresh.reuse_detected"
  | "auth.refresh.family_expired"
  | "auth.session.revoked"
  | "auth.password_reset.requested"
  | "auth.password_reset.completed"
  | "admin.calls_active.viewed";

export interface AuditLogEntry {
  event: AuditEvent;
  severity: AuditSeverity;
  userId?: string;
  email?: string;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditLogDocument extends AuditLogEntry {
  _id: ObjectId;
  createdAt: Date;
}

async function getCollection() {
  const db = await connectMongo();
  return db.collection<AuditLogDocument>("audit_logs");
}

export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    const collection = await getCollection();
    await collection.insertOne({
      ...entry,
      createdAt: new Date(),
    } as AuditLogDocument);
  } catch (err) {
    // Never let an audit-log failure take down the request path it's
    // observing — but always surface it, since a silently-broken audit
    // trail is itself a security incident.
    logger.error({ err, event: entry.event }, "Failed to write audit log entry");
  }

  if (entry.severity === "critical") {
    logger.warn({ event: entry.event, userId: entry.userId, ip: entry.ip }, "Critical audit event");
  }
}

export async function queryAuditLogsForUser(userId: string, limit = 50): Promise<AuditLogDocument[]> {
  const collection = await getCollection();
  return collection.find({ userId }).sort({ createdAt: -1 }).limit(limit).toArray();
}
