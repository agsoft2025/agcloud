import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../../helpers/buildTestApp.js";
import { getFakeDb, resetFakes } from "../../helpers/mockDb.js";
import { authHeader } from "../../helpers/fixtures.js";
import { ObjectId } from "mongodb";

describe("Notification (device) Routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetFakes();
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  describe("POST /devices/register", () => {
    it("returns 400 for an invalid platform", async () => {
      const userId = new ObjectId().toString();
      const response = await app.inject({
        method: "POST",
        url: "/devices/register",
        headers: authHeader(userId, "u@example.com"),
        payload: { platform: "windows", token: "abc" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("returns 400 when token is missing", async () => {
      const userId = new ObjectId().toString();
      const response = await app.inject({
        method: "POST",
        url: "/devices/register",
        headers: authHeader(userId, "u@example.com"),
        payload: { platform: "android" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("registers a device successfully and persists it", async () => {
      const userId = new ObjectId().toString();
      const response = await app.inject({
        method: "POST",
        url: "/devices/register",
        headers: authHeader(userId, "u@example.com"),
        payload: { platform: "ios", token: "device-token-1", voipToken: "voip-1" },
      });
      expect(response.statusCode).toBe(201);
      expect(JSON.parse(response.payload).message).toBe("Device registered successfully");

      const device = await getFakeDb()
        .collection("devices")
        .findOne({ userId, token: "device-token-1" });
      expect(device).toBeTruthy();
      expect(device!.platform).toBe("ios");
      expect(device!.voipToken).toBe("voip-1");
    });

    it("requires authentication", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/devices/register",
        payload: { platform: "android", token: "abc" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("returns 500 when the underlying registration throws a non-validation error", async () => {
      const userId = new ObjectId().toString();
      vi.spyOn(getFakeDb().collection("devices"), "updateOne").mockRejectedValueOnce(new Error("db down"));

      const response = await app.inject({
        method: "POST",
        url: "/devices/register",
        headers: authHeader(userId, "u@example.com"),
        payload: { platform: "android", token: "abc" },
      });
      expect(response.statusCode).toBe(500);
    });
  });

  describe("DELETE /devices/:token", () => {
    it("unregisters an existing device", async () => {
      const userId = new ObjectId().toString();
      await app.inject({
        method: "POST",
        url: "/devices/register",
        headers: authHeader(userId, "u@example.com"),
        payload: { platform: "android", token: "device-token-2" },
      });

      const response = await app.inject({
        method: "DELETE",
        url: "/devices/device-token-2",
        headers: authHeader(userId, "u@example.com"),
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).message).toBe("Device unregistered");

      const device = await getFakeDb()
        .collection("devices")
        .findOne({ userId, token: "device-token-2" });
      expect(device).toBeNull();
    });

    it("is idempotent for a token that was never registered", async () => {
      const userId = new ObjectId().toString();
      const response = await app.inject({
        method: "DELETE",
        url: "/devices/never-registered-token",
        headers: authHeader(userId, "u@example.com"),
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).message).toBe("Device unregistered");
    });

    it("requires authentication", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: "/devices/some-token",
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
