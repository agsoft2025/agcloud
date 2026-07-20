import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetFakes, getFakeDb } from "../../helpers/mockDb.js";
import { presenceRepo, ONLINE_THRESHOLD_MS, HEARTBEAT_TIMEOUT_MS } from "../../../src/modules/presence/presence.service.js";
import {
  startPresenceWorker,
  stopPresenceWorker,
  cleanupOnStartup,
} from "../../../src/modules/presence/presence.worker.js";
import { makeUserDoc } from "../../helpers/fixtures.js";

const NOW = new Date("2026-01-01T12:00:00.000Z").getTime();

describe("presence.worker", () => {
  beforeEach(() => {
    resetFakes();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    stopPresenceWorker();
    vi.useRealTimers();
  });

  it("evaluation loop transitions an idle-but-connected ONLINE user to AWAY after 60s", async () => {
    await presenceRepo.setPresenceFields("user-1", {
      status: "ONLINE",
      lastActivity: new Date(NOW - ONLINE_THRESHOLD_MS - 1000).toISOString(),
      lastHeartbeat: new Date(NOW - 1000).toISOString(),
    });
    await presenceRepo.addSocket("user-1", "socket-1");

    startPresenceWorker();
    await vi.advanceTimersByTimeAsync(60_000);

    const presence = await presenceRepo.getPresence("user-1");
    expect(presence?.status).toBe("AWAY");
  });

  it("evaluation loop transitions a disconnected, stale user to OFFLINE", async () => {
    await presenceRepo.setPresenceFields("user-2", {
      status: "AWAY",
      lastActivity: new Date(NOW - HEARTBEAT_TIMEOUT_MS - 1000).toISOString(),
      lastHeartbeat: new Date(NOW - HEARTBEAT_TIMEOUT_MS - 1000).toISOString(),
    });

    startPresenceWorker();
    await vi.advanceTimersByTimeAsync(60_000);

    const presence = await presenceRepo.getPresence("user-2");
    expect(presence?.status).toBe("OFFLINE");
  });

  it("stopPresenceWorker prevents further evaluation", async () => {
    await presenceRepo.setPresenceFields("user-3", {
      status: "ONLINE",
      lastActivity: new Date(NOW - ONLINE_THRESHOLD_MS - 1000).toISOString(),
      lastHeartbeat: new Date(NOW - 1000).toISOString(),
    });
    await presenceRepo.addSocket("user-3", "socket-1");

    startPresenceWorker();
    stopPresenceWorker();
    await vi.advanceTimersByTimeAsync(120_000);

    const presence = await presenceRepo.getPresence("user-3");
    expect(presence?.status).toBe("ONLINE");
  });

  it("cleanupOnStartup clears stale socket sets, evaluates, and syncs to the DB", async () => {
    const userDoc = makeUserDoc({ presenceStatus: "offline" });
    await getFakeDb().collection("users").insertOne(userDoc as any);
    const userId = userDoc._id.toString();

    await presenceRepo.setPresenceFields(userId, {
      status: "AWAY",
      lastActivity: new Date(NOW - HEARTBEAT_TIMEOUT_MS - 1000).toISOString(),
      lastHeartbeat: new Date(NOW - HEARTBEAT_TIMEOUT_MS - 1000).toISOString(),
      lastSeen: new Date(NOW).toISOString(),
    });
    // Stale socket set left over from a previous process.
    await presenceRepo.addSocket(userId, "dead-socket");

    await cleanupOnStartup();

    expect(await presenceRepo.getSocketCount(userId)).toBe(0);
    const dbUser = await getFakeDb().collection("users").findOne({ _id: userDoc._id } as any);
    expect((dbUser as any)?.presenceStatus).toBe("offline");
  });
});
