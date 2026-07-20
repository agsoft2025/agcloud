import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFakeRedis, resetFakes } from "../../helpers/mockDb.js";
import { PresenceRepository, BROADCAST_CHANNEL } from "../../../src/modules/presence/presence.repository.js";

describe("PresenceRepository", () => {
  let repo: PresenceRepository;

  beforeEach(() => {
    resetFakes();
    repo = new PresenceRepository();
  });

  describe("getPresence / setPresenceFields", () => {
    it("round-trips presence fields through the hash", async () => {
      await repo.setPresenceFields("user-1", {
        status: "ONLINE",
        lastActivity: "2024-01-01T00:00:00.000Z",
        lastHeartbeat: "2024-01-01T00:00:01.000Z",
        lastSeen: "",
      });

      const data = await repo.getPresence("user-1");
      expect(data?.status).toBe("ONLINE");
      expect(data?.lastActivity).toBe("2024-01-01T00:00:00.000Z");
    });

    it("returns null when there is no status field", async () => {
      const data = await repo.getPresence("unknown-user");
      expect(data).toBeNull();
    });

    it("does nothing when fields is empty", async () => {
      await repo.setPresenceFields("user-1", {});
      const data = await repo.getPresence("user-1");
      expect(data).toBeNull();
    });
  });

  describe("addSocket / removeSocket / getSocketCount", () => {
    it("tracks sockets via a set", async () => {
      await repo.addSocket("user-1", "socket-a");
      await repo.addSocket("user-1", "socket-b");
      expect(await repo.getSocketCount("user-1")).toBe(2);

      await repo.removeSocket("user-1", "socket-a");
      expect(await repo.getSocketCount("user-1")).toBe(1);
    });

    it("returns 0 for a user with no sockets", async () => {
      expect(await repo.getSocketCount("nobody")).toBe(0);
    });
  });

  describe("grace period", () => {
    it("sets, checks, and clears a grace period", async () => {
      expect(await repo.hasGracePeriod("user-1")).toBe(false);
      await repo.setGracePeriod("user-1", 30);
      expect(await repo.hasGracePeriod("user-1")).toBe(true);
      await repo.clearGracePeriod("user-1");
      expect(await repo.hasGracePeriod("user-1")).toBe(false);
    });
  });

  describe("getAllPresenceUserIds", () => {
    it("returns user ids from presence keys, excluding :sockets and :grace suffixed keys", async () => {
      await repo.setPresenceFields("user-1", { status: "ONLINE", lastActivity: "", lastHeartbeat: "", lastSeen: "" });
      await repo.setPresenceFields("user-2", { status: "AWAY", lastActivity: "", lastHeartbeat: "", lastSeen: "" });
      await repo.addSocket("user-1", "socket-a");
      await repo.setGracePeriod("user-2", 30);

      const ids = await repo.getAllPresenceUserIds();
      expect(ids.sort()).toEqual(["user-1", "user-2"].sort());
    });

    it("returns an empty array when there is no presence data", async () => {
      const ids = await repo.getAllPresenceUserIds();
      expect(ids).toEqual([]);
    });
  });

  describe("clearAllSocketSets", () => {
    it("deletes all sockets sets via a pipeline", async () => {
      await repo.addSocket("user-1", "socket-a");
      await repo.addSocket("user-2", "socket-b");
      expect(await repo.getSocketCount("user-1")).toBe(1);
      expect(await repo.getSocketCount("user-2")).toBe(1);

      await repo.clearAllSocketSets();

      expect(await repo.getSocketCount("user-1")).toBe(0);
      expect(await repo.getSocketCount("user-2")).toBe(0);
    });

    it("does nothing (and doesn't throw) when there are no socket sets", async () => {
      await expect(repo.clearAllSocketSets()).resolves.toBeUndefined();
    });
  });

  describe("batchGetSocketCounts", () => {
    it("returns a map of userId -> socket count via a pipeline", async () => {
      await repo.addSocket("user-1", "a");
      await repo.addSocket("user-1", "b");
      await repo.addSocket("user-2", "c");

      const counts = await repo.batchGetSocketCounts(["user-1", "user-2", "user-3"]);
      expect(counts.get("user-1")).toBe(2);
      expect(counts.get("user-2")).toBe(1);
      expect(counts.get("user-3")).toBe(0);
    });

    it("returns an empty map for an empty input", async () => {
      const counts = await repo.batchGetSocketCounts([]);
      expect(counts.size).toBe(0);
    });

    it("returns an empty map when the pipeline yields no results", async () => {
      vi.spyOn(getFakeRedis(), "pipeline").mockReturnValueOnce({ scard: () => ({}), exec: async () => null } as any);
      const counts = await repo.batchGetSocketCounts(["user-1"]);
      expect(counts.size).toBe(0);
    });
  });

  describe("batchGetPresence", () => {
    it("returns a map of userId -> presence data via a pipeline", async () => {
      await repo.setPresenceFields("user-1", { status: "ONLINE", lastActivity: "x", lastHeartbeat: "y", lastSeen: "" });

      const map = await repo.batchGetPresence(["user-1", "user-2"]);
      expect(map.get("user-1")?.status).toBe("ONLINE");
      expect(map.get("user-2")).toBeNull();
    });

    it("returns an empty map for an empty input", async () => {
      const map = await repo.batchGetPresence([]);
      expect(map.size).toBe(0);
    });

    it("returns an empty map when the pipeline yields no results", async () => {
      vi.spyOn(getFakeRedis(), "pipeline").mockReturnValueOnce({ hgetall: () => ({}), exec: async () => null } as any);
      const map = await repo.batchGetPresence(["user-1"]);
      expect(map.size).toBe(0);
    });
  });

  describe("publish", () => {
    it("publishes to the given channel", async () => {
      await repo.publish(BROADCAST_CHANNEL, JSON.stringify({ event: "USER_ONLINE", userId: "user-1" }));
      const published = getFakeRedis().published;
      expect(published).toHaveLength(1);
      expect(published[0].channel).toBe(BROADCAST_CHANNEL);
      expect(JSON.parse(published[0].message)).toMatchObject({ event: "USER_ONLINE", userId: "user-1" });
    });
  });
});
