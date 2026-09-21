/**
 * Admin action audit trail.
 *
 * Records admin-initiated mutations (user management, pricing, plan
 * management) in `admin_audit_log` with before/after snapshots.
 *
 * Distinct from the security audit log (`shared/security/audit-log.ts`),
 * which tracks auth/session events. This log is for business-action
 * accountability.
 *
 * Writes are fire-and-forget: never block or fail the request path.
 * Callers should invoke `void writeAdminAuditLog(...)` to make the
 * non-blocking intent explicit.
 */

import { ObjectId } from "mongodb";
import { connectMongo } from "./db/mongo.client.js";
import logger from "./observability/logger.js";

// ── Action enum ───────────────────────────────────────────────────────────────

export type AdminAuditAction =
  // User management
  | "user.updated"             // role / status / displayName change
  | "user.deleted"
  // Pricing rates
  | "pricing_rate.created"
  | "pricing_rate.updated"
  | "pricing_rate.deleted"
  // Billing settings
  | "billing_settings.updated"
  // Subscription plans
  | "subscription_plan.created"
  | "subscription_plan.updated"
  | "subscription_plan.deleted";

export type AdminAuditTargetType =
  | "user"
  | "pricing_rate"
  | "billing_settings"
  | "subscription_plan";

// ── Document shape ────────────────────────────────────────────────────────────

export interface AdminAuditLogEntry {
  /** ID of the admin who performed the action */
  adminId: string;
  adminEmail: string;
  action: AdminAuditAction;
  targetType: AdminAuditTargetType;
  /** MongoDB _id string of the affected document, or null for global settings */
  targetId: string | null;
  /** Human-readable label for the target (email, plan name, etc.) */
  targetLabel: string | null;
  /** State before the change — only non-sensitive fields */
  before: Record<string, unknown> | null;
  /** State after the change — only non-sensitive fields */
  after: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}

export interface AdminAuditLogDocument extends AdminAuditLogEntry {
  _id: ObjectId;
  timestamp: Date;
}

// ── Collection accessor ───────────────────────────────────────────────────────

async function getCollection() {
  const db = await connectMongo();
  return db.collection<AdminAuditLogDocument>("admin_audit_log");
}

// ── Write helper (fire-and-forget) ────────────────────────────────────────────

export async function writeAdminAuditLog(entry: AdminAuditLogEntry): Promise<void> {
  try {
    const col = await getCollection();
    await col.insertOne({
      ...entry,
      timestamp: new Date(),
    } as AdminAuditLogDocument);
  } catch (err) {
    // Never let an audit-log failure take down the request that triggered it.
    logger.error({ err, action: entry.action }, "Failed to write admin audit log entry");
  }
}

// ── Query helper (for the admin UI endpoint) ──────────────────────────────────

export async function queryAdminAuditLog(opts: {
  page:     number;
  limit:    number;
  action?:  string;
  adminId?: string;
}): Promise<{ entries: AdminAuditLogDocument[]; total: number }> {
  const { page, limit, action, adminId } = opts;
  const col = await getCollection();

  const filter: Record<string, unknown> = {};
  if (action)  filter.action  = action;
  if (adminId) filter.adminId = adminId;

  const skip = (page - 1) * limit;

  const [entries, total] = await Promise.all([
    col.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).toArray(),
    col.countDocuments(filter),
  ]);

  return { entries, total };
}
