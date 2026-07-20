import { describe, it, expect, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { getFakeDb, resetFakes } from "../../helpers/mockDb.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { makeUserDoc } from "../../helpers/fixtures.js";
import type { UserDocument } from "../../../src/modules/user/user.schemas.js";

describe("UserRepository", () => {
  let repo: UserRepository;

  beforeEach(() => {
    resetFakes();
    repo = new UserRepository();
  });

  function col() {
    return getFakeDb().collection<UserDocument>("users");
  }

  describe("listContacts", () => {
    it("excludes suspended/deleted users and blocked users", async () => {
      await col().insertOne(makeUserDoc({ displayName: "Active User", status: "active", isBlocked: false }));
      await col().insertOne(makeUserDoc({ displayName: "Suspended User", status: "suspended" }));
      await col().insertOne(makeUserDoc({ displayName: "Deleted User", status: "deleted" }));
      await col().insertOne(makeUserDoc({ displayName: "Blocked User", status: "active", isBlocked: true }));

      const result = await repo.listContacts({ page: 1, limit: 20 });
      expect(result.users).toHaveLength(1);
      expect(result.users[0].displayName).toBe("Active User");
      expect(result.total).toBe(1);
    });

    it("excludes the given excludeUserId via $ne on _id", async () => {
      const me = makeUserDoc({ displayName: "Me" });
      const other = makeUserDoc({ displayName: "Other" });
      await col().insertOne(me);
      await col().insertOne(other);

      const result = await repo.listContacts({ page: 1, limit: 20, excludeUserId: me._id.toString() });
      expect(result.users).toHaveLength(1);
      expect(result.users[0].displayName).toBe("Other");
    });

    it("builds a case-insensitive regex $or across displayName/email/phoneNumber/extensionNumber", async () => {
      await col().insertOne(makeUserDoc({ displayName: "Alice Smith", email: "alice@example.com" }));
      await col().insertOne(makeUserDoc({ displayName: "Bob Jones", email: "bob@example.com" }));

      const result = await repo.listContacts({ page: 1, limit: 20, search: "alice" });
      expect(result.users).toHaveLength(1);
      expect(result.users[0].displayName).toBe("Alice Smith");
    });

    it("matches search against email even with different case", async () => {
      await col().insertOne(makeUserDoc({ displayName: "Carol", email: "carol@Example.com" }));
      const result = await repo.listContacts({ page: 1, limit: 20, search: "EXAMPLE.COM" });
      expect(result.users).toHaveLength(1);
    });

    it("computes skip/limit pagination and total via countDocuments", async () => {
      for (let i = 0; i < 25; i++) {
        await col().insertOne(makeUserDoc({ displayName: `User ${i}` }));
      }
      const page2 = await repo.listContacts({ page: 2, limit: 10 });
      expect(page2.users).toHaveLength(10);
      expect(page2.total).toBe(25);
      expect(page2.page).toBe(2);
      expect(page2.limit).toBe(10);

      const page3 = await repo.listContacts({ page: 3, limit: 10 });
      expect(page3.users).toHaveLength(5);
    });

    it("ignores an invalid excludeUserId instead of throwing", async () => {
      await col().insertOne(makeUserDoc({ displayName: "Someone" }));
      await expect(repo.listContacts({ page: 1, limit: 20, excludeUserId: "not-an-id" })).resolves.toMatchObject({
        total: 1,
      });
    });
  });

  describe("getAllPresence", () => {
    it("projects only presenceStatus/lastSeenAt and defaults status to offline", async () => {
      const withPresence = makeUserDoc({ presenceStatus: "online", lastSeenAt: new Date("2024-01-01") });
      await col().insertOne(withPresence);
      // Insert a doc without presenceStatus field to trigger default.
      const bare = makeUserDoc();
      delete (bare as any).presenceStatus;
      await col().insertOne(bare);

      const presence = await repo.getAllPresence();
      expect(presence).toHaveLength(2);
      const p1 = presence.find((p) => p.userId === withPresence._id.toString());
      expect(p1!.status).toBe("online");
      expect(p1!.lastSeen).toBeTruthy();

      const p2 = presence.find((p) => p.userId === bare._id.toString());
      expect(p2!.status).toBe("offline");
    });
  });

  describe("setPresence", () => {
    it("sets presenceStatus and lastSeenAt", async () => {
      const user = makeUserDoc({ presenceStatus: "offline" });
      await col().insertOne(user);
      await repo.setPresence(user._id.toString(), "online");
      const updated = await col().findOne({ _id: user._id });
      expect(updated!.presenceStatus).toBe("online");
      expect(updated!.lastSeenAt).toBeTruthy();
    });

    it("silently ignores an invalid userId", async () => {
      await expect(repo.setPresence("bad-id", "online")).resolves.toBeUndefined();
    });
  });

  describe("getUserById", () => {
    it("returns the user when found", async () => {
      const user = makeUserDoc();
      await col().insertOne(user);
      const found = await repo.getUserById(user._id.toString());
      expect(found?._id.toString()).toBe(user._id.toString());
    });

    it("returns null for an invalid ObjectId", async () => {
      await expect(repo.getUserById("not-an-id")).resolves.toBeNull();
    });

    it("returns null when not found", async () => {
      await expect(repo.getUserById(new ObjectId().toString())).resolves.toBeNull();
    });
  });

  describe("syncPresenceToDb", () => {
    it("lowercases ONLINE/AWAY/OFFLINE for the DB enum", async () => {
      const user = makeUserDoc();
      await col().insertOne(user);
      await repo.syncPresenceToDb(user._id.toString(), "ONLINE");
      let updated = await col().findOne({ _id: user._id });
      expect(updated!.presenceStatus).toBe("online");

      await repo.syncPresenceToDb(user._id.toString(), "AWAY");
      updated = await col().findOne({ _id: user._id });
      expect(updated!.presenceStatus).toBe("away");

      await repo.syncPresenceToDb(user._id.toString(), "OFFLINE");
      updated = await col().findOne({ _id: user._id });
      expect(updated!.presenceStatus).toBe("offline");
    });

    it("only writes lastSeenAt when a lastSeen arg is passed", async () => {
      const user = makeUserDoc({ lastSeenAt: undefined as unknown as Date });
      await col().insertOne(user);

      await repo.syncPresenceToDb(user._id.toString(), "ONLINE");
      let updated = await col().findOne({ _id: user._id });
      expect(updated!.lastSeenAt).toBeUndefined();
      expect(updated!.updatedAt).toBeTruthy();

      const lastSeen = new Date("2024-05-05");
      await repo.syncPresenceToDb(user._id.toString(), "AWAY", lastSeen);
      updated = await col().findOne({ _id: user._id });
      expect(updated!.lastSeenAt).toEqual(lastSeen);
    });

    it("silently ignores an invalid userId", async () => {
      await expect(repo.syncPresenceToDb("bad-id", "ONLINE")).resolves.toBeUndefined();
    });
  });
});
