import { describe, it, expect, beforeEach } from "vitest";
import { getFakeDb, resetFakes } from "../../helpers/mockDb.js";
import { RefreshTokenRepository } from "../../../src/modules/auth/refresh-token.repository.js";
import type { RefreshTokenDocument } from "../../../src/modules/auth/auth.types.js";

describe("RefreshTokenRepository", () => {
  let repo: RefreshTokenRepository;

  beforeEach(() => {
    resetFakes();
    repo = new RefreshTokenRepository();
  });

  function col() {
    return getFakeDb().collection<RefreshTokenDocument>("refresh_tokens");
  }

  describe("createFamily", () => {
    it("creates a new token family", async () => {
      const { jti, familyId } = await repo.createFamily("user-1", { userAgent: "ua", ip: "1.2.3.4" });
      expect(jti).toBeTruthy();
      expect(familyId).toBeTruthy();

      const doc = await col().findOne({ jti });
      expect(doc).toBeTruthy();
      expect(doc!.userId).toBe("user-1");
      expect(doc!.familyId).toBe(familyId);
      expect(doc!.used).toBe(false);
      expect(doc!.revoked).toBe(false);
      expect(doc!.deviceInfo).toEqual({ userAgent: "ua", ip: "1.2.3.4" });

      const expectedMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
      expect(Math.abs(doc!.expiresAt.getTime() - expectedMs)).toBeLessThan(5000);
    });
  });

  describe("findByJti", () => {
    it("returns the doc when found", async () => {
      const { jti } = await repo.createFamily("user-1", { userAgent: null, ip: null });
      const found = await repo.findByJti(jti);
      expect(found?.jti).toBe(jti);
    });

    it("returns null when not found", async () => {
      const found = await repo.findByJti("does-not-exist");
      expect(found).toBeNull();
    });
  });

  describe("rotate", () => {
    it("issues a new jti and marks the previous one used", async () => {
      const { jti } = await repo.createFamily("user-1", { userAgent: null, ip: null });
      const previous = await repo.findByJti(jti);
      const { jti: newJti } = await repo.rotate(previous!);

      expect(newJti).not.toBe(jti);

      const oldDoc = await repo.findByJti(jti);
      expect(oldDoc!.used).toBe(true);
      expect(oldDoc!.usedAt).toBeTruthy();
      expect(oldDoc!.replacedByJti).toBe(newJti);

      const newDoc = await repo.findByJti(newJti);
      expect(newDoc).toBeTruthy();
      expect(newDoc!.familyId).toBe(previous!.familyId);
      expect(newDoc!.familyCreatedAt.getTime()).toBe(previous!.familyCreatedAt.getTime());
      expect(newDoc!.used).toBe(false);
    });

    it("caps the sliding expiry at the family's absolute max age when the family is old", async () => {
      const familyCreatedAt = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000);
      const previous: RefreshTokenDocument = {
        _id: (await col().insertOne({
          jti: "old-jti",
          userId: "user-1",
          familyId: "fam-1",
          familyCreatedAt,
          issuedAt: familyCreatedAt,
          expiresAt: new Date(Date.now() + 1000),
          used: false,
          usedAt: null,
          revoked: false,
          revokedAt: null,
          revokedReason: null,
          replacedByJti: null,
          deviceInfo: { userAgent: null, ip: null },
        } as RefreshTokenDocument)).insertedId,
        jti: "old-jti",
        userId: "user-1",
        familyId: "fam-1",
        familyCreatedAt,
        issuedAt: familyCreatedAt,
        expiresAt: new Date(Date.now() + 1000),
        used: false,
        usedAt: null,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
        replacedByJti: null,
        deviceInfo: { userAgent: null, ip: null },
      };

      const { jti: newJti } = await repo.rotate(previous);
      const newDoc = await repo.findByJti(newJti);

      const absoluteExpiry = familyCreatedAt.getTime() + 30 * 24 * 60 * 60 * 1000;
      const slidingExpiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
      expect(absoluteExpiry).toBeLessThan(slidingExpiry);
      expect(Math.abs(newDoc!.expiresAt.getTime() - absoluteExpiry)).toBeLessThan(5000);
    });
  });

  describe("revokeFamily", () => {
    it("revokes every non-revoked token in the family", async () => {
      const { jti: jti1, familyId } = await repo.createFamily("user-1", { userAgent: null, ip: null });
      const previous = await repo.findByJti(jti1);
      const { jti: jti2 } = await repo.rotate(previous!);

      await repo.revokeFamily(familyId, "logout");

      const doc2 = await repo.findByJti(jti2);
      expect(doc2!.revoked).toBe(true);
      expect(doc2!.revokedReason).toBe("logout");
      expect(doc2!.revokedAt).toBeTruthy();
    });
  });

  describe("revokeAllForUser", () => {
    it("revokes tokens across every family for that user only", async () => {
      const { familyId: fam1 } = await repo.createFamily("user-1", { userAgent: null, ip: null });
      const { familyId: fam2 } = await repo.createFamily("user-1", { userAgent: null, ip: null });
      const { familyId: famOther } = await repo.createFamily("user-2", { userAgent: null, ip: null });

      await repo.revokeAllForUser("user-1", "logout_all");

      const sessions1 = await col().find({ familyId: fam1 }).toArray();
      const sessions2 = await col().find({ familyId: fam2 }).toArray();
      const sessionsOther = await col().find({ familyId: famOther }).toArray();
      expect(sessions1.every((s) => s.revoked)).toBe(true);
      expect(sessions2.every((s) => s.revoked)).toBe(true);
      expect(sessionsOther.every((s) => !s.revoked)).toBe(true);
    });
  });

  describe("revokeFamilyForUser", () => {
    it("revokes and returns true when the family belongs to the user", async () => {
      const { familyId } = await repo.createFamily("user-1", { userAgent: null, ip: null });
      const result = await repo.revokeFamilyForUser(familyId, "user-1", "logout");
      expect(result).toBe(true);
      const doc = await col().findOne({ familyId });
      expect(doc!.revoked).toBe(true);
    });

    it("returns false and does not revoke when the family belongs to a different user", async () => {
      const { familyId } = await repo.createFamily("user-1", { userAgent: null, ip: null });
      const result = await repo.revokeFamilyForUser(familyId, "user-2", "logout");
      expect(result).toBe(false);
      const doc = await col().findOne({ familyId });
      expect(doc!.revoked).toBe(false);
    });
  });

  describe("listActiveSessionsForUser", () => {
    it("collapses rotations to the latest per family, excludes revoked/expired, marks isCurrent", async () => {
      // Family A: two rotations, still active.
      const { jti: jtiA1, familyId: famA } = await repo.createFamily("user-1", { userAgent: "A", ip: null });
      const prevA = await repo.findByJti(jtiA1);
      await repo.rotate(prevA!);

      // Family B: active, single rotation - this will be "current".
      const { familyId: famB } = await repo.createFamily("user-1", { userAgent: "B", ip: null });

      // Family C: revoked - must be excluded.
      const { familyId: famC } = await repo.createFamily("user-1", { userAgent: "C", ip: null });
      await repo.revokeFamily(famC, "logout");

      // Family D: expired - must be excluded.
      await col().insertOne({
        jti: "expired-jti",
        userId: "user-1",
        familyId: "fam-expired",
        familyCreatedAt: new Date(Date.now() - 100000),
        issuedAt: new Date(Date.now() - 100000),
        expiresAt: new Date(Date.now() - 1000),
        used: false,
        usedAt: null,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
        replacedByJti: null,
        deviceInfo: { userAgent: null, ip: null },
      } as RefreshTokenDocument);

      const sessions = await repo.listActiveSessionsForUser("user-1", famB);

      expect(sessions).toHaveLength(2);
      const famIds = sessions.map((s) => s.familyId).sort();
      expect(famIds).toEqual([famA, famB].sort());

      const sessionB = sessions.find((s) => s.familyId === famB);
      expect(sessionB!.isCurrent).toBe(true);
      const sessionA = sessions.find((s) => s.familyId === famA);
      expect(sessionA!.isCurrent).toBe(false);
    });
  });
});
