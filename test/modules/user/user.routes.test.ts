import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { buildTestApp } from "../../helpers/buildTestApp.js";
import { getFakeDb, getFakeRedis, resetFakes } from "../../helpers/mockDb.js";
import { authHeader, makeUserDoc } from "../../helpers/fixtures.js";

describe("User Routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetFakes();
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  function newId(): ObjectId {
    return new ObjectId();
  }

  async function seedUser(overrides: Record<string, unknown> = {}) {
    const doc = makeUserDoc(overrides);
    await getFakeDb().collection("users").insertOne(doc);
    return doc;
  }

  describe("GET /users", () => {
    it("excludes suspended/deleted/blocked users and the requester's own id", async () => {
      const me = await seedUser({ displayName: "Me" });
      const active = await seedUser({ displayName: "Active Buddy" });
      await seedUser({ displayName: "Suspended Person", status: "suspended" });
      await seedUser({ displayName: "Deleted Person", status: "deleted" });
      await seedUser({ displayName: "Blocked Person", isBlocked: true });

      const response = await app.inject({
        method: "GET",
        url: "/users",
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const ids = body.users.map((u: any) => u.id);
      expect(ids).toContain(active._id.toString());
      expect(ids).not.toContain(me._id.toString());
      expect(body.users).toHaveLength(1);
    });

    it("supports search across displayName/email/phoneNumber/extensionNumber", async () => {
      const me = await seedUser({ displayName: "Me" });
      await seedUser({ displayName: "Zebra Person", email: "zebra@example.com" });
      await seedUser({ displayName: "Someone Else", email: "other@example.com", phoneNumber: "5551234" });

      const response = await app.inject({
        method: "GET",
        url: "/users?search=zebra",
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.users).toHaveLength(1);
      expect(body.users[0].displayName).toBe("Zebra Person");
    });

    it("defaults contacts with no Redis presence record to offline", async () => {
      const me = await seedUser({ displayName: "Me" });
      await seedUser({ displayName: "Buddy" });

      const response = await app.inject({
        method: "GET",
        url: "/users",
        headers: authHeader(me._id.toString(), me.email),
      });
      const body = JSON.parse(response.payload);
      expect(body.users[0].presenceStatus).toBe("offline");
    });

    it("paginates results", async () => {
      const me = await seedUser({ displayName: "Me" });
      for (let i = 0; i < 5; i++) {
        await seedUser({ displayName: `Buddy ${i}` });
      }

      const response = await app.inject({
        method: "GET",
        url: "/users?page=1&limit=2",
        headers: authHeader(me._id.toString(), me.email),
      });
      const body = JSON.parse(response.payload);
      expect(body.users).toHaveLength(2);
      expect(body.total).toBe(5);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(2);
    });
  });

  describe("GET /users/presence", () => {
    it("returns bulk presence for every user, defaulting missing Redis records to offline", async () => {
      const me = await seedUser({ displayName: "Me" });
      const other = await seedUser({ displayName: "Buddy" });

      const response = await app.inject({
        method: "GET",
        url: "/users/presence",
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const entry = body.find((p: any) => p.userId === other._id.toString());
      expect(entry.status).toBe("offline");
    });
  });

  describe("GET /users/:id/presence", () => {
    it("returns 404 when the target user doesn't exist and has no Redis presence", async () => {
      const me = await seedUser({ displayName: "Me" });

      const response = await app.inject({
        method: "GET",
        url: `/users/${newId().toString()}/presence`,
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(404);
    });

    it("falls back to DB lastSeenAt when there is no Redis record", async () => {
      const me = await seedUser({ displayName: "Me" });
      const lastSeenAt = new Date("2026-07-01T00:00:00.000Z");
      const target = await seedUser({ displayName: "Buddy", lastSeenAt });

      const response = await app.inject({
        method: "GET",
        url: `/users/${target._id.toString()}/presence`,
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe("OFFLINE");
      expect(body.isConnected).toBe(false);
      expect(body.activeDevices).toBe(0);
      expect(body.lastSeen).toBe(lastSeenAt.toISOString());
    });

    it("returns live presence when a Redis record exists", async () => {
      const me = await seedUser({ displayName: "Me" });
      const target = await seedUser({ displayName: "Buddy" });
      const now = new Date().toISOString();
      await getFakeRedis().hset(`presence:user:${target._id.toString()}`, {
        status: "ONLINE",
        lastActivity: now,
        lastHeartbeat: now,
        lastSeen: now,
      });

      const response = await app.inject({
        method: "GET",
        url: `/users/${target._id.toString()}/presence`,
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe("ONLINE");
      expect(body.lastSeen).toBe(now);
    });
  });

  describe("PUT /users/me", () => {
    it("updates displayName and avatarUrl", async () => {
      const me = await seedUser({ displayName: "Old Name" });

      const response = await app.inject({
        method: "PUT",
        url: "/users/me",
        headers: authHeader(me._id.toString(), me.email),
        payload: { displayName: "New Name", avatarUrl: "https://example.com/a.png" },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.displayName).toBe("New Name");
      expect(body.avatarUrl).toBe("https://example.com/a.png");
      expect(body.passwordHash).toBeUndefined();
    });

    it("returns 400 on invalid body", async () => {
      const me = await seedUser({ displayName: "Old Name" });

      const response = await app.inject({
        method: "PUT",
        url: "/users/me",
        headers: authHeader(me._id.toString(), me.email),
        payload: { displayName: "a" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("returns 404 when the token's user id isn't in the DB", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/users/me",
        headers: authHeader(newId().toString(), "ghost@example.com"),
        payload: { displayName: "Ghost Name" },
      });
      expect(response.statusCode).toBe(404);
    });

    it("returns 500 when the update itself throws a non-validation error", async () => {
      const userId = newId();
      await getFakeDb().collection("users").insertOne(makeUserDoc({ _id: userId }) as any);
      vi.spyOn(getFakeDb().collection("users"), "findOneAndUpdate").mockRejectedValueOnce(new Error("db down"));

      const response = await app.inject({
        method: "PUT",
        url: "/users/me",
        headers: authHeader(userId.toString(), "u@example.com"),
        payload: { displayName: "New Name" },
      });
      expect(response.statusCode).toBe(500);
    });
  });

  describe("GET /users/:id", () => {
    it("returns 404 when missing", async () => {
      const me = await seedUser({ displayName: "Me" });

      const response = await app.inject({
        method: "GET",
        url: `/users/${newId().toString()}`,
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(404);
    });

    it("returns the enriched contact shape", async () => {
      const me = await seedUser({ displayName: "Me" });
      const target = await seedUser({ displayName: "Buddy" });

      const response = await app.inject({
        method: "GET",
        url: `/users/${target._id.toString()}`,
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.id).toBe(target._id.toString());
      expect(body.displayName).toBe("Buddy");
      expect(body.presenceStatus).toBe("offline");
    });
  });

  describe("Contacts CRUD (/users/me/contacts)", () => {
    it("GET returns an empty list when no contacts have been added", async () => {
      const me = await seedUser({ displayName: "Me" });
      const response = await app.inject({
        method: "GET",
        url: "/users/me/contacts",
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).contacts).toEqual([]);
    });

    it("POST adds a contact, and GET returns it enriched with presence", async () => {
      const me = await seedUser({ displayName: "Me" });
      const buddy = await seedUser({ displayName: "Buddy" });

      const addResponse = await app.inject({
        method: "POST",
        url: "/users/me/contacts",
        headers: authHeader(me._id.toString(), me.email),
        payload: { userId: buddy._id.toString() },
      });
      expect(addResponse.statusCode).toBe(201);

      const listResponse = await app.inject({
        method: "GET",
        url: "/users/me/contacts",
        headers: authHeader(me._id.toString(), me.email),
      });
      const body = JSON.parse(listResponse.payload);
      expect(body.contacts).toHaveLength(1);
      expect(body.contacts[0].id).toBe(buddy._id.toString());
      expect(body.contacts[0].presenceStatus).toBe("offline");
    });

    it("POST is idempotent — adding the same contact twice does not duplicate it", async () => {
      const me = await seedUser({ displayName: "Me" });
      const buddy = await seedUser({ displayName: "Buddy" });

      for (let i = 0; i < 2; i++) {
        await app.inject({
          method: "POST",
          url: "/users/me/contacts",
          headers: authHeader(me._id.toString(), me.email),
          payload: { userId: buddy._id.toString() },
        });
      }

      const listResponse = await app.inject({
        method: "GET",
        url: "/users/me/contacts",
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(JSON.parse(listResponse.payload).contacts).toHaveLength(1);
    });

    it("POST returns 400 when adding yourself", async () => {
      const me = await seedUser({ displayName: "Me" });
      const response = await app.inject({
        method: "POST",
        url: "/users/me/contacts",
        headers: authHeader(me._id.toString(), me.email),
        payload: { userId: me._id.toString() },
      });
      expect(response.statusCode).toBe(400);
    });

    it("POST returns 404 when the target user does not exist", async () => {
      const me = await seedUser({ displayName: "Me" });
      const response = await app.inject({
        method: "POST",
        url: "/users/me/contacts",
        headers: authHeader(me._id.toString(), me.email),
        payload: { userId: newId().toString() },
      });
      expect(response.statusCode).toBe(404);
    });

    it("DELETE removes a contact", async () => {
      const me = await seedUser({ displayName: "Me" });
      const buddy = await seedUser({ displayName: "Buddy" });
      await app.inject({
        method: "POST",
        url: "/users/me/contacts",
        headers: authHeader(me._id.toString(), me.email),
        payload: { userId: buddy._id.toString() },
      });

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/users/me/contacts/${buddy._id.toString()}`,
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(deleteResponse.statusCode).toBe(200);

      const listResponse = await app.inject({
        method: "GET",
        url: "/users/me/contacts",
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(JSON.parse(listResponse.payload).contacts).toEqual([]);
    });

    it("DELETE returns 404 when the contact doesn't exist", async () => {
      const me = await seedUser({ displayName: "Me" });
      const response = await app.inject({
        method: "DELETE",
        url: `/users/me/contacts/${newId().toString()}`,
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(404);
    });

    it("contacts are per-owner — adding a contact doesn't add the reverse relationship", async () => {
      const me = await seedUser({ displayName: "Me" });
      const buddy = await seedUser({ displayName: "Buddy" });
      await app.inject({
        method: "POST",
        url: "/users/me/contacts",
        headers: authHeader(me._id.toString(), me.email),
        payload: { userId: buddy._id.toString() },
      });

      const buddysContacts = await app.inject({
        method: "GET",
        url: "/users/me/contacts",
        headers: authHeader(buddy._id.toString(), buddy.email),
      });
      expect(JSON.parse(buddysContacts.payload).contacts).toEqual([]);
    });
  });

  describe("Blocklist (/users/me/block/:id)", () => {
    it("GET /users/me/blocked returns an empty list initially", async () => {
      const me = await seedUser({ displayName: "Me" });
      const response = await app.inject({
        method: "GET",
        url: "/users/me/blocked",
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).blocked).toEqual([]);
    });

    it("POST blocks a user, reflected in GET /users/me/blocked", async () => {
      const me = await seedUser({ displayName: "Me" });
      const jerk = await seedUser({ displayName: "Rude Person" });

      const blockResponse = await app.inject({
        method: "POST",
        url: `/users/me/block/${jerk._id.toString()}`,
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(blockResponse.statusCode).toBe(201);

      const listResponse = await app.inject({
        method: "GET",
        url: "/users/me/blocked",
        headers: authHeader(me._id.toString(), me.email),
      });
      const body = JSON.parse(listResponse.payload);
      expect(body.blocked).toHaveLength(1);
      expect(body.blocked[0].id).toBe(jerk._id.toString());
    });

    it("POST returns 400 when blocking yourself", async () => {
      const me = await seedUser({ displayName: "Me" });
      const response = await app.inject({
        method: "POST",
        url: `/users/me/block/${me._id.toString()}`,
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(400);
    });

    it("POST returns 404 when the target user does not exist", async () => {
      const me = await seedUser({ displayName: "Me" });
      const response = await app.inject({
        method: "POST",
        url: `/users/me/block/${newId().toString()}`,
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(404);
    });

    it("DELETE unblocks a user", async () => {
      const me = await seedUser({ displayName: "Me" });
      const jerk = await seedUser({ displayName: "Rude Person" });
      await app.inject({
        method: "POST",
        url: `/users/me/block/${jerk._id.toString()}`,
        headers: authHeader(me._id.toString(), me.email),
      });

      const unblockResponse = await app.inject({
        method: "DELETE",
        url: `/users/me/block/${jerk._id.toString()}`,
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(unblockResponse.statusCode).toBe(200);

      const listResponse = await app.inject({
        method: "GET",
        url: "/users/me/blocked",
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(JSON.parse(listResponse.payload).blocked).toEqual([]);
    });

    it("DELETE returns 404 when there was no block to remove", async () => {
      const me = await seedUser({ displayName: "Me" });
      const response = await app.inject({
        method: "DELETE",
        url: `/users/me/block/${newId().toString()}`,
        headers: authHeader(me._id.toString(), me.email),
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
