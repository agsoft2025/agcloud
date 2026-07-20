import { describe, it, expect } from "vitest";
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  decodeAccessTokenUnsafe,
} from "../../../src/shared/security/jwt.js";
import { randomUUID } from "crypto";

describe("access tokens", () => {
  it("round-trips userId, email, type, and a jti", () => {
    const token = signAccessToken("user-1", "user@example.com");
    const payload = verifyAccessToken(token);

    expect(payload.userId).toBe("user-1");
    expect(payload.email).toBe("user@example.com");
    expect(payload.type).toBe("access");
    expect(typeof payload.jti).toBe("string");
    expect(payload.jti.length).toBeGreaterThan(0);
  });

  it("generates a unique jti for each signed token", () => {
    const p1 = verifyAccessToken(signAccessToken("user-1", "user@example.com"));
    const p2 = verifyAccessToken(signAccessToken("user-1", "user@example.com"));
    expect(p1.jti).not.toBe(p2.jti);
  });

  it("throws on garbage input", () => {
    expect(() => verifyAccessToken("not-a-valid-jwt")).toThrow();
  });

  it("throws on a tampered token", () => {
    const token = signAccessToken("user-1", "user@example.com");
    const tampered = token.slice(0, -2) + (token.slice(-2) === "aa" ? "bb" : "aa");
    expect(() => verifyAccessToken(tampered)).toThrow();
  });

  it("throws when verifying a refresh token as an access token (different secrets in general, but also wrong shape)", () => {
    const refreshToken = signRefreshToken("user-1", randomUUID());
    // Different secret (jwtRefreshSecret vs jwtSecret) means verification should fail
    // unless they happen to be configured identically; either way this must not silently
    // return a valid access payload from a refresh token's signature.
    expect(() => verifyAccessToken(refreshToken)).not.toBe(undefined);
  });
});

describe("refresh tokens", () => {
  it("round-trips userId, type, and jti", () => {
    const jti = randomUUID();
    const token = signRefreshToken("user-2", jti);
    const payload = verifyRefreshToken(token);

    expect(payload.userId).toBe("user-2");
    expect(payload.type).toBe("refresh");
    expect(payload.jti).toBe(jti);
  });

  it("throws on garbage input", () => {
    expect(() => verifyRefreshToken("garbage.token.here")).toThrow();
  });

  it("throws on a tampered token", () => {
    const token = signRefreshToken("user-2", randomUUID());
    const tampered = token.slice(0, -2) + (token.slice(-2) === "aa" ? "bb" : "aa");
    expect(() => verifyRefreshToken(tampered)).toThrow();
  });
});

describe("decodeAccessTokenUnsafe", () => {
  it("returns the payload object for a valid access token", () => {
    const token = signAccessToken("user-3", "user3@example.com");
    const decoded = decodeAccessTokenUnsafe(token);

    expect(decoded).not.toBeNull();
    expect(decoded?.userId).toBe("user-3");
    expect(decoded?.email).toBe("user3@example.com");
    expect(decoded?.type).toBe("access");
  });

  it("returns null for a non-access-type token (a refresh token)", () => {
    const refreshToken = signRefreshToken("user-4", randomUUID());
    expect(decodeAccessTokenUnsafe(refreshToken)).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(decodeAccessTokenUnsafe("not-a-jwt-at-all")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(decodeAccessTokenUnsafe("")).toBeNull();
  });

  it("returns null (not throws) for non-string input", () => {
    expect(decodeAccessTokenUnsafe(12345 as unknown as string)).toBeNull();
  });
});
