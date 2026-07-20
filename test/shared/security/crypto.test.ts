import { describe, it, expect } from "vitest";
import { generateSecureToken, hashToken, safeCompare } from "../../../src/shared/security/crypto.js";

describe("generateSecureToken", () => {
  it("returns a hex string of the correct length for the default byteLength", () => {
    const token = generateSecureToken();
    expect(token).toMatch(/^[0-9a-f]+$/);
    expect(token.length).toBe(32 * 2);
  });

  it("returns a hex string of the correct length for a custom byteLength", () => {
    const token = generateSecureToken(16);
    expect(token).toMatch(/^[0-9a-f]+$/);
    expect(token.length).toBe(16 * 2);
  });

  it("generates unique tokens across calls", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateSecureToken()));
    expect(tokens.size).toBe(50);
  });
});

describe("hashToken", () => {
  it("is deterministic - same input produces same output", () => {
    expect(hashToken("my-token")).toBe(hashToken("my-token"));
  });

  it("produces a 64-character hex SHA-256 digest", () => {
    const digest = hashToken("my-token");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different output for different input", () => {
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
  });
});

describe("safeCompare", () => {
  it("returns true for equal strings", () => {
    expect(safeCompare("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(safeCompare("abc123", "abc124")).toBe(false);
  });

  it("returns false (without throwing) for strings of different lengths", () => {
    expect(() => safeCompare("short", "a much longer string")).not.toThrow();
    expect(safeCompare("short", "a much longer string")).toBe(false);
  });

  it("returns false for an empty string vs a non-empty string", () => {
    expect(safeCompare("", "a")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(safeCompare("", "")).toBe(true);
  });
});
