import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { buildTestApp } from "../../helpers/buildTestApp.js";
import { getFakeDb, resetFakes } from "../../helpers/mockDb.js";
import { authHeader, makeCallDoc } from "../../helpers/fixtures.js";
import type { AuditLogDocument } from "../../../src/shared/security/audit-log.js";

describe("Admin Routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetFakes();
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  async function seedCall(overrides: Record<string, unknown> = {}) {
    const doc = makeCallDoc({ _id: new ObjectId(), ...overrides });
    await getFakeDb().collection("calls").insertOne(doc);
    return doc;
  }

  describe("GET /admin/calls/active", () => {
    it("returns 401 without authentication", async () => {
      const response = await app.inject({ method: "GET", url: "/admin/calls/active" });
      expect(response.statusCode).toBe(401);
    });

    it("returns 403 for an authenticated non-admin user", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/calls/active",
        headers: authHeader("user-1", "user1@example.com", "user"),
      });
      expect(response.statusCode).toBe(403);
    });

    it("returns only initiated/active calls for an admin, excluding ended/missed/cancelled", async () => {
      await seedCall({ status: "initiated" });
      await seedCall({ status: "active" });
      await seedCall({ status: "ended" });
      await seedCall({ status: "missed" });
      await seedCall({ status: "cancelled" });

      const response = await app.inject({
        method: "GET",
        url: "/admin/calls/active",
        headers: authHeader("admin-1", "admin@example.com", "admin"),
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.total).toBe(2);
      expect(body.calls).toHaveLength(2);
      expect(
        body.calls.every((c: { status: string }) => ["initiated", "active"].includes(c.status))
      ).toBe(true);
    });

    it("paginates results", async () => {
      for (let i = 0; i < 5; i++) {
        await seedCall({ status: "active" });
      }

      const response = await app.inject({
        method: "GET",
        url: "/admin/calls/active?page=1&limit=2",
        headers: authHeader("admin-1", "admin@example.com", "admin"),
      });

      const body = JSON.parse(response.payload);
      expect(body.total).toBe(5);
      expect(body.calls).toHaveLength(2);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(2);
    });

    it("writes an audit log entry for the admin who viewed active calls", async () => {
      await seedCall({ status: "active" });

      const response = await app.inject({
        method: "GET",
        url: "/admin/calls/active",
        headers: authHeader("admin-1", "admin@example.com", "admin"),
      });
      expect(response.statusCode).toBe(200);

      const entries = await getFakeDb()
        .collection<AuditLogDocument>("audit_logs")
        .find({ userId: "admin-1" })
        .toArray();
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe("admin.calls_active.viewed");
      expect(entries[0].email).toBe("admin@example.com");
    });

    it("does not write an audit log entry when the caller is rejected", async () => {
      await app.inject({
        method: "GET",
        url: "/admin/calls/active",
        headers: authHeader("user-1", "user1@example.com", "user"),
      });

      const entries = await getFakeDb()
        .collection<AuditLogDocument>("audit_logs")
        .find({})
        .toArray();
      expect(entries).toHaveLength(0);
    });
  });
});
