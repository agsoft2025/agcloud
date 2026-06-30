import jwt from "jsonwebtoken";
import config from "../../config/index.js";

export interface AccessTokenPayload {
  userId: string;
  email: string;
  type: "access";
}

export interface RefreshTokenPayload {
  userId: string;
  type: "refresh";
  jti: string; // unique token ID for revocation
}

/** Sign a short-lived access token (default 15 min). */
export function signAccessToken(userId: string, email: string): string {
  const payload: AccessTokenPayload = { userId, email, type: "access" };
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: (config.jwtAccessTokenExpiresIn as any) ?? "15m",
  });
}

/** Sign a longer-lived refresh token (default 7 days). */
export function signRefreshToken(userId: string, jti: string): string {
  const payload: RefreshTokenPayload = { userId, type: "refresh", jti };
  return jwt.sign(payload, config.jwtRefreshSecret, { expiresIn: "7d" });
}

/** Verify an access token. Throws if invalid or expired. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.jwtSecret) as AccessTokenPayload;
}

/** Verify a refresh token. Throws if invalid or expired. */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.jwtRefreshSecret) as RefreshTokenPayload;
}
