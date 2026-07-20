import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetFakes, getFakeRedis } from "../../helpers/mockDb.js";
import {
  computeStatus,
  handleConnection,
  handleDisconnect,
  handleHeartbeat,
  handleActivity,
  getPresenceForUser,
  presenceRepo,
  ONLINE_THRESHOLD_MS,
  HEARTBEAT_TIMEOUT_MS,
} from "../../../src/modules/presence/presence.service.js";
import type { RedisPresenceData } from "../../../src/modules/presence/presence.types.js";

const NOW = new Date("2026-01-01T12:00:00.000Z").getTime();

describe("presence.service", () => {
  beforeEach(() => {
    resetFakes();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("computeStatus", () => {
    it("is ONLINE when lastActivity is within the online threshold", () => {
      const presence: RedisPresenceData = {
        status: "ONLINE",
        lastActivity: new Date(NOW - 1000).toISOString(),
        lastHeartbeat: new Date(NOW - 1000).toISOString(),
      } as RedisPresenceData;
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      expect(computeStatus(presence, 1)).toBe("ONLINE");
    });

    it("is AWAY when activity is stale but a socket is still open", () => {
      const presence: RedisPresenceData = {
        status: "ONLINE",
        lastActivity: new Date(NOW - ONLINE_THRESHOLD_MS - 1000).toISOString(),
        lastHeartbeat: new Date(NOW - 1000).toISOString(),
      } as RedisPresenceData;
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      expect(computeStatus(presence, 1)).toBe("AWAY");
    });

    it("is OFFLINE when no socket and both signals are stale beyond the heartbeat timeout", () => {
      const presence: RedisPresenceData = {
        status: "AWAY",
        lastActivity: new Date(NOW - HEARTBEAT_TIMEOUT_MS - 1000).toISOString(),
        lastHeartbeat: new Date(NOW - HEARTBEAT_TIMEOUT_MS - 1000).toISOString(),
      } as RedisPresenceData;
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      expect(computeStatus(presence, 0)).toBe("OFFLINE");
    });

    it("is AWAY (not yet OFFLINE) when no socket but signals are within the heartbeat timeout", () => {
      const presence: RedisPresenceData = {
        status: "AWAY",
        lastActivity: new Date(NOW - ONLINE_THRESHOLD_MS - 1000).toISOString(),
        lastHeartbeat: new Date(NOW - ONLINE_THRESHOLD_MS - 1000).toISOString(),
      } as RedisPresenceData;
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      expect(computeStatus(presence, 0)).toBe("AWAY");
    });
  });

  describe("handleConnection", () => {
    it("sets status ONLINE and broadcasts USER_ONLINE for a previously-offline user", async () => {
      await handleConnection("user-1", "socket-1");

      const presence = await presenceRepo.getPresence("user-1");
      expect(presence?.status).toBe("ONLINE");

      const redis = getFakeRedis();
      const events = redis.published.map((p) => JSON.parse(p.message));
      expect(events.some((e) => e.event === "USER_ONLINE" && e.userId === "user-1")).toBe(true);
    });

    it("broadcasts PRESENCE_UPDATED (not USER_ONLINE) when the user was already ONLINE", async () => {
      await handleConnection("user-2", "socket-1");
      const redis = getFakeRedis();
      redis.published = [];

      await handleConnection("user-2", "socket-2");
      const events = redis.published.map((p) => JSON.parse(p.message));
      expect(events.some((e) => e.event === "PRESENCE_UPDATED")).toBe(true);
      expect(events.some((e) => e.event === "USER_ONLINE")).toBe(false);
    });
  });

  describe("handleDisconnect + _checkAndMarkOffline (via setTimeout)", () => {
    it("marks the user OFFLINE after the grace period when the heartbeat is stale", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);

      // Seed a connected user whose heartbeat is already stale beyond the timeout.
      await presenceRepo.setPresenceFields("user-3", {
        status: "ONLINE",
        lastActivity: new Date(NOW - HEARTBEAT_TIMEOUT_MS - 1000).toISOString(),
        lastHeartbeat: new Date(NOW - HEARTBEAT_TIMEOUT_MS - 1000).toISOString(),
        lastSeen: new Date(NOW).toISOString(),
      });
      await presenceRepo.addSocket("user-3", "socket-1");

      await handleDisconnect("user-3", "socket-1");
      expect(await presenceRepo.getSocketCount("user-3")).toBe(0);
      expect(await presenceRepo.hasGracePeriod("user-3")).toBe(true);

      await vi.advanceTimersByTimeAsync(35_000);

      const presence = await presenceRepo.getPresence("user-3");
      expect(presence?.status).toBe("OFFLINE");
    });

    it("does not mark the user OFFLINE if their heartbeat is still fresh", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);

      await presenceRepo.setPresenceFields("user-4", {
        status: "ONLINE",
        lastActivity: new Date(NOW - 1000).toISOString(),
        lastHeartbeat: new Date(NOW - 1000).toISOString(),
        lastSeen: new Date(NOW).toISOString(),
      });
      await presenceRepo.addSocket("user-4", "socket-1");

      await handleDisconnect("user-4", "socket-1");
      await vi.advanceTimersByTimeAsync(35_000);

      const presence = await presenceRepo.getPresence("user-4");
      expect(presence?.status).toBe("ONLINE");
    });
  });

  describe("handleHeartbeat", () => {
    it("updates only lastHeartbeat, not lastActivity", async () => {
      const before = new Date(NOW - 100_000).toISOString();
      await presenceRepo.setPresenceFields("user-5", {
        status: "ONLINE",
        lastActivity: before,
        lastHeartbeat: before,
      });

      await handleHeartbeat("user-5");

      const presence = await presenceRepo.getPresence("user-5");
      expect(presence?.lastActivity).toBe(before);
      expect(presence?.lastHeartbeat).not.toBe(before);
    });
  });

  describe("handleActivity", () => {
    it("is throttled to once per 30s", async () => {
      const setSpy = vi.spyOn(presenceRepo, "setPresenceFields");
      await handleActivity("user-6");
      await handleActivity("user-6");
      expect(setSpy).toHaveBeenCalledTimes(1);
    });

    it("broadcasts USER_ONLINE when transitioning from a non-ONLINE status", async () => {
      await presenceRepo.setPresenceFields("user-7", {
        status: "OFFLINE",
        lastActivity: new Date(NOW - HEARTBEAT_TIMEOUT_MS - 1000).toISOString(),
        lastHeartbeat: new Date(NOW - HEARTBEAT_TIMEOUT_MS - 1000).toISOString(),
      });
      const redis = getFakeRedis();
      redis.published = [];

      await handleActivity("user-7");

      const events = redis.published.map((p) => JSON.parse(p.message));
      expect(events.some((e) => e.event === "USER_ONLINE" && e.userId === "user-7")).toBe(true);
    });
  });

  describe("getPresenceForUser", () => {
    it("returns null when no presence record exists", async () => {
      expect(await getPresenceForUser("nobody")).toBeNull();
    });

    it("returns the enriched shape when a presence record exists", async () => {
      await handleConnection("user-8", "socket-1");
      const result = await getPresenceForUser("user-8");
      expect(result).toMatchObject({ userId: "user-8", status: "ONLINE", isConnected: true, activeDevices: 1 });
    });
  });
});
