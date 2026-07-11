import { ObjectId } from "mongodb";

export type RevokedReason =
  | "rotated"
  | "logout"
  | "logout_all"
  | "reuse_detected"
  | "device_revoked"
  | "family_expired";

export interface DeviceInfo {
  userAgent: string | null;
  ip: string | null;
}

/**
 * One document per issued refresh token (one per rotation).
 * `jti` matches the `jti` claim inside the signed refresh-token JWT — the JWT
 * signature proves authenticity/expiry cheaply, this document is the
 * server-side source of truth for whether that specific token has already
 * been used (rotated away) or revoked.
 *
 * `familyId` is stable across every rotation that descends from a single
 * login. Reuse of an already-`used` token revokes the whole family — that is
 * the standard refresh-token-rotation theft signal: a well-behaved client
 * never presents a token twice, so a second presentation means someone else
 * has a copy.
 */
export interface RefreshTokenDocument {
  _id: ObjectId;
  jti: string;
  userId: string;
  familyId: string;
  familyCreatedAt: Date;
  issuedAt: Date;
  expiresAt: Date;
  used: boolean;
  usedAt: Date | null;
  revoked: boolean;
  revokedAt: Date | null;
  revokedReason: RevokedReason | null;
  replacedByJti: string | null;
  deviceInfo: DeviceInfo;
}

/** Shape returned by GET /auth/sessions — one entry per active login (device), not per rotation. */
export interface SessionSummary {
  familyId: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  deviceInfo: DeviceInfo;
  isCurrent: boolean;
}
