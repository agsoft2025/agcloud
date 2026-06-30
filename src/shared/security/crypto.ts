import crypto from "crypto";

/** Generate a cryptographically secure random hex token of `byteLength` bytes. */
export function generateSecureToken(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString("hex");
}

/** SHA-256 hash a token for safe storage (one-way). */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison to prevent timing attacks. */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
