import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFakeDb, resetFakes } from "../../helpers/mockDb.js";
import logger from "../../../src/shared/observability/logger.js";
import { writeAuditLog, queryAuditLogsForUser } from "../../../src/shared/security/audit-log.js";
import type { AuditLogDocument } from "../../../src/shared/security/audit-log.js";

describe("audit-log", () => {
  beforeEach(() => {
    resetFakes();
    vi.restoreAllMocks();
  });

  function col() {
    return getFakeDb().collection<AuditLogDocument>("audit_logs");
  }

  describe("writeAuditLog", () => {
    it("inserts an entry into audit_logs with a createdAt timestamp", async () => {
      await writeAuditLog({ event: "auth.signin.success", severity: "info", userId: "user-1", email: "a@b.com" });
      const docs = await col().find({ userId: "user-1" }).toArray();
      expect(docs).toHaveLength(1);
      expect(docs[0].event).toBe("auth.signin.success");
      expect(docs[0].createdAt).toBeTruthy();
    });

    it("never throws even when the insert fails", async () => {
      vi.spyOn(col(), "insertOne").mockRejectedValue(new Error("insert failed"));
      const errSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      await expect(
        writeAuditLog({ event: "auth.signin.failed", severity: "warning", userId: "user-1" })
      ).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
    });

    it("triggers logger.warn additionally when severity is critical", async () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      await writeAuditLog({ event: "auth.refresh.reuse_detected", severity: "critical", userId: "user-1", ip: "1.2.3.4" });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: "auth.refresh.reuse_detected", userId: "user-1", ip: "1.2.3.4" }),
        "Critical audit event"
      );
    });

    it("does not trigger logger.warn for non-critical severities", async () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      await writeAuditLog({ event: "auth.signin.success", severity: "info", userId: "user-1" });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("queryAuditLogsForUser", () => {
    it("filters by userId, sorts desc by createdAt, and respects the limit", async () => {
      const now = Date.now();
      await col().insertOne({
        _id: undefined as any,
        event: "auth.signin.success",
        severity: "info",
        userId: "user-1",
        createdAt: new Date(now - 3000),
      } as AuditLogDocument);
      await col().insertOne({
        _id: undefined as any,
        event: "auth.signout",
        severity: "info",
        userId: "user-1",
        createdAt: new Date(now - 1000),
      } as AuditLogDocument);
      await col().insertOne({
        _id: undefined as any,
        event: "auth.signin.success",
        severity: "info",
        userId: "user-1",
        createdAt: new Date(now - 2000),
      } as AuditLogDocument);
      await col().insertOne({
        _id: undefined as any,
        event: "auth.signin.success",
        severity: "info",
        userId: "user-other",
        createdAt: new Date(now),
      } as AuditLogDocument);

      const results = await queryAuditLogsForUser("user-1");
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.event)).toEqual(["auth.signout", "auth.signin.success", "auth.signin.success"]);
    });

    it("defaults limit to 50 and respects an explicit limit", async () => {
      for (let i = 0; i < 10; i++) {
        await col().insertOne({
          _id: undefined as any,
          event: "auth.signin.success",
          severity: "info",
          userId: "user-1",
          createdAt: new Date(Date.now() - i * 1000),
        } as AuditLogDocument);
      }
      const limited = await queryAuditLogsForUser("user-1", 3);
      expect(limited).toHaveLength(3);

      const defaulted = await queryAuditLogsForUser("user-1");
      expect(defaulted).toHaveLength(10);
    });
  });
});
