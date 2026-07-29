/**
 * Presence Service
 *
 * Single source of truth for presence logic.
 *
 * Multi-instance architecture
 * ----------------------------
 *  - Redis hash  presence:user:{id}          <- authoritative state
 *  - Redis set   presence:user:{id}:sockets  <- active socket IDs
 *  - Redis key   presence:user:{id}:grace    <- reconnection window (TTL=30s)
 *  - Redis pub   presence:broadcast          <- cross-instance event fan-out
 */

import type { Server as SocketIOServer } from "socket.io";
import { getRedisClient } from "../../shared/db/redis.client.js";
import logger from "../../shared/observability/logger.js";
import { UserRepository } from "../user/user.repository.js";
import { ContactRepository } from "../contact/contact.repository.js";
import { PresenceRepository, BROADCAST_CHANNEL } from "./presence.repository.js";
import type { PresenceBroadcast, PresenceStatus, RedisPresenceData } from "./presence.types.js";

const presenceRepo = new PresenceRepository();
const userRepo = new UserRepository();
const contactRepo = new ContactRepository();
let io: SocketIOServer | null = null;

// ---- Thresholds ----

export const ONLINE_THRESHOLD_MS = 2 * 60_000; // 2 min
export const HEARTBEAT_AWAY_MS = 60_000; // 1 min (kept for worker compat)
export const HEARTBEAT_TIMEOUT_MS = 10 * 60_000; // 10 min

const ACTIVITY_THROTTLE_MS = 30_000; // 30 s
const GRACE_PERIOD_SECONDS = 30;

// ---- Bootstrap ----

export function setSocketIOServer(server: SocketIOServer): void {
  io = server;
  _setupSubscriber();
}

function _setupSubscriber(): void {
  const sub = getRedisClient().duplicate();

  // Must attach error listener BEFORE subscribe, otherwise a connection
  // failure becomes an unhandled rejection that crashes the process.
  sub.on("error", (err: Error) => {
    logger.warn({ err }, "Presence subscriber connection error");
  });

  sub.subscribe(BROADCAST_CHANNEL, (err) => {
    if (err) logger.error({ err }, "Presence subscribe failed");
    else logger.info({ channel: BROADCAST_CHANNEL }, "Presence subscriber subscribed");
  });

  sub.on("message", (_channel: string, raw: string) => {
    try {
      const event = JSON.parse(raw) as PresenceBroadcast;
      void _deliverToWatchers(event);
    } catch (err) {
      logger.error({ err }, "Malformed presence broadcast message");
    }
  });
}

// ---- Internal helpers ----

async function _broadcast(event: PresenceBroadcast): Promise<void> {
  await presenceRepo.publish(BROADCAST_CHANNEL, JSON.stringify(event));
}

/**
 * Deliver a presence event only to sockets that should see it: the user's
 * own other devices (multi-device sync) plus anyone who has this user saved
 * as a contact. Replaces the old behavior of broadcasting to every connected
 * socket regardless of whether the two users know each other.
 */
async function _deliverToWatchers(event: PresenceBroadcast): Promise<void> {
  if (!io) return;

  try {
    const watcherIds = await contactRepo.getWatchersOf(event.userId);
    io.to("user:" + event.userId).emit(event.event, event);
    for (const watcherId of watcherIds) {
      io.to("user:" + watcherId).emit(event.event, event);
    }
  } catch (err) {
    logger.error(
      { err, userId: event.userId },
      "Failed to resolve contact watchers for presence broadcast"
    );
  }
}

// ---- Status computation ----

/**
 * Derives PresenceStatus from Redis data.
 *
 * Rules:
 *  1. ONLINE  -- API activity within 2 min
 *  2. AWAY    -- socket open OR either signal within 10 min
 *  3. OFFLINE -- no socket AND both activity + heartbeat stale > 10 min
 *
 * Math.max(lastActivity, lastHeartbeat) is used so a stale heartbeat from a
 * previous session does not cause premature OFFLINE after a fresh login.
 */
export function computeStatus(presence: RedisPresenceData, socketCount: number): PresenceStatus {
  const now = Date.now();
  const lastAct = new Date(presence.lastActivity).getTime();
  const lastHB = new Date(presence.lastHeartbeat).getTime();
  const lastSignal = Math.max(lastAct, lastHB);

  if (now - lastAct <= ONLINE_THRESHOLD_MS) return "ONLINE";
  if (socketCount > 0) return "AWAY";
  if (now - lastSignal > HEARTBEAT_TIMEOUT_MS) return "OFFLINE";
  return "AWAY";
}

// ---- WebSocket lifecycle ----

export async function handleConnection(userId: string, socketId: string): Promise<void> {
  const now = new Date().toISOString();

  await Promise.all([
    presenceRepo.addSocket(userId, socketId),
    presenceRepo.clearGracePeriod(userId),
  ]);

  const existing = await presenceRepo.getPresence(userId);
  const previousStatus = existing?.status ?? "OFFLINE";

  await presenceRepo.setPresenceFields(userId, {
    status: "ONLINE",
    lastActivity: now,
    lastHeartbeat: now,
    lastSeen: existing?.lastSeen ?? now,
  });

  const socketCount = await presenceRepo.getSocketCount(userId);

  if (previousStatus !== "ONLINE") {
    await _broadcast({
      event: "USER_ONLINE",
      userId,
      status: "ONLINE",
      activeDevices: socketCount,
    });
  } else {
    await _broadcast({
      event: "PRESENCE_UPDATED",
      userId,
      status: "ONLINE",
      activeDevices: socketCount,
    });
  }
}

export async function handleDisconnect(userId: string, socketId: string): Promise<void> {
  await presenceRepo.removeSocket(userId, socketId);
  const socketCount = await presenceRepo.getSocketCount(userId);

  if (socketCount === 0) {
    await presenceRepo.setGracePeriod(userId, GRACE_PERIOD_SECONDS);
    setTimeout(() => void _checkAndMarkOffline(userId), (GRACE_PERIOD_SECONDS + 5) * 1000);
  }
}

export async function _checkAndMarkOffline(userId: string): Promise<void> {
  const [socketCount, hasGrace] = await Promise.all([
    presenceRepo.getSocketCount(userId),
    presenceRepo.hasGracePeriod(userId),
  ]);

  if (socketCount > 0 || hasGrace) return;

  const presence = await presenceRepo.getPresence(userId);
  if (!presence || presence.status === "OFFLINE") return;

  const lastAct = new Date(presence.lastActivity).getTime();
  const lastHB = new Date(presence.lastHeartbeat).getTime();
  const msSinceLastSignal = Date.now() - Math.max(lastAct, lastHB);

  if (msSinceLastSignal > HEARTBEAT_TIMEOUT_MS) {
    const lastSeen = new Date().toISOString();
    await presenceRepo.setPresenceFields(userId, { status: "OFFLINE", lastSeen });
    userRepo.syncPresenceToDb(userId, "OFFLINE", new Date(lastSeen)).catch(() => {});
    await _broadcast({ event: "USER_OFFLINE", userId, status: "OFFLINE", lastSeen });
  }
}

// ---- Heartbeat ----

export async function handleHeartbeat(userId: string): Promise<void> {
  await presenceRepo.setPresenceFields(userId, {
    lastHeartbeat: new Date().toISOString(),
  });
}

// ---- Activity middleware hook ----

/**
 * Called after every authenticated HTTP request.
 * Throttled to once per 30 s.
 * Always refreshes lastHeartbeat alongside lastActivity so a stale heartbeat
 * from a previous session cannot cause premature OFFLINE after login.
 */
export async function handleActivity(userId: string): Promise<void> {
  const presence = await presenceRepo.getPresence(userId);
  const now = Date.now();

  if (presence) {
    const msSinceLast = now - new Date(presence.lastActivity).getTime();
    if (msSinceLast < ACTIVITY_THROTTLE_MS) return;
  }

  const nowStr = new Date(now).toISOString();
  const previousStatus = presence?.status ?? "OFFLINE";

  await presenceRepo.setPresenceFields(userId, {
    status: "ONLINE",
    lastActivity: nowStr,
    lastHeartbeat: nowStr,
    ...(presence ? {} : { lastSeen: nowStr }),
  });

  if (previousStatus !== "ONLINE") {
    const socketCount = await presenceRepo.getSocketCount(userId);
    await _broadcast({
      event: "USER_ONLINE",
      userId,
      status: "ONLINE",
      activeDevices: socketCount,
    });
  }
}

// ---- REST API helper ----

export async function getPresenceForUser(userId: string): Promise<{
  userId: string;
  status: PresenceStatus;
  lastSeen: string | null;
  activeDevices: number;
  isConnected: boolean;
} | null> {
  const [presence, socketCount] = await Promise.all([
    presenceRepo.getPresence(userId),
    presenceRepo.getSocketCount(userId),
  ]);

  if (!presence) return null;

  const status = computeStatus(presence, socketCount);

  return {
    userId,
    status,
    lastSeen: presence.lastSeen ?? null,
    activeDevices: socketCount,
    isConnected: socketCount > 0,
  };
}

export { presenceRepo };
