import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import config from "../../config/index.js";

export interface AccessTokenPayload {
  userId: string;
  email: string;
  role: string;
  type: "access";
  jti: string; // unique token ID, used only for the logout/logout-all denylist
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  userId: string;
  type: "refresh";
  jti: string; // unique token ID — the source of truth for rotation/revocation lives in Mongo, keyed by this
  iat?: number;
  exp?: number;
}

/**
 * Sign a short-lived access token (default 15 min).
 * Every access token carries a random `jti` so a single token can be
 * individually revoked (via the Redis denylist) before its natural expiry —
 * without that, "logout" and "logout everywhere" could only ever be
 * client-side cookie clears, and a stolen token would stay valid for its
 * full remaining lifetime no matter what the server does.
 *
 * `role` is embedded at issuance time (not looked up per-request) so
 * authorization checks in `authenticate`/`requireRole` don't need a DB round
 * trip on every request. A role change takes effect on the user's next
 * sign-in or token refresh, not instantly — an acceptable trade-off given
 * the ≤15-minute access token lifetime.
 */
export function signAccessToken(userId: string, email: string, role: string): string {
  const payload: Omit<AccessTokenPayload, "iat" | "exp"> = {
    userId,
    email,
    role,
    type: "access",
    jti: randomUUID(),
  };
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: (config.jwtAccessTokenExpiresIn as any) ?? "15m",
  });
}

/** Sign a longer-lived, single-use, rotating refresh token. */
export function signRefreshToken(userId: string, jti: string): string {
  const payload: Omit<RefreshTokenPayload, "iat" | "exp"> = { userId, type: "refresh", jti };
  return jwt.sign(payload, config.jwtRefreshSecret, {
    expiresIn: `${config.refreshTokenTtlDays}d`,
  });
}

/** Verify an access token. Throws if invalid or expired. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.jwtSecret) as AccessTokenPayload;
}

/** Verify a refresh token. Throws if invalid or expired. */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.jwtRefreshSecret) as RefreshTokenPayload;
}

/**
 * Decode an access token without verifying its signature/expiry.
 * Used only at logout time to recover the `jti` + `exp` of a token that may
 * already be expired or otherwise invalid, purely so it can be denylisted —
 * never use this result to authorize anything.
 */
export function decodeAccessTokenUnsafe(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.decode(token);
    if (decoded && typeof decoded === "object" && (decoded as any).type === "access") {
      return decoded as AccessTokenPayload;
    }
    return null;
  } catch {
    return null;
  }
}
