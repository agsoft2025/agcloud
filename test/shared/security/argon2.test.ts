import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { hashPassword, verifyPassword } from "../../../src/shared/security/argon2.js";

describe("hashPassword / verifyPassword (argon2id)", () => {
  it("produces a verifiable argon2id hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it("returns valid:true and needsRehash:false for a correct password against a fresh argon2 hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    const result = await verifyPassword("correct horse battery staple", hash);
    expect(result).toEqual({ valid: true, needsRehash: false });
  });

  it("returns valid:false for a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    const result = await verifyPassword("wrong password", hash);
    expect(result.valid).toBe(false);
  });

  it("returns valid:false (no throw) for a malformed/garbage stored hash", async () => {
    const result = await verifyPassword("anything", "not-a-real-hash");
    expect(result).toEqual({ valid: false, needsRehash: false });
  });

  it("verifies a legacy bcrypt hash correctly and flags needsRehash:true", async () => {
    const bcryptHash = await bcrypt.hash("legacy-password", 10);
    expect(bcryptHash.startsWith("$2b$") || bcryptHash.startsWith("$2a$")).toBe(true);

    const result = await verifyPassword("legacy-password", bcryptHash);
    expect(result).toEqual({ valid: true, needsRehash: true });
  });

  it("returns valid:false for a wrong password against a legacy bcrypt hash", async () => {
    const bcryptHash = await bcrypt.hash("legacy-password", 10);
    const result = await verifyPassword("wrong-password", bcryptHash);
    expect(result).toEqual({ valid: false, needsRehash: false });
  });
});
