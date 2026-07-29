// Presence Worker
//
// Runs two background intervals:
//   1. Evaluation loop (every 60s) -- applies state-transition rules to all Redis presence records
//   2. Database sync (every 5min)  -- persists Redis status to MongoDB
//
// Also exports cleanupOnStartup() which must be called once at boot to:
//   a) Clear stale Redis socket sets left over from the previous process
//   b) Immediately evaluate all users so anyone with a dead connection is
//      marked OFFLINE in Redis and MongoDB before any client connects

import {
  presenceRepo,
  computeStatus,
  ONLINE_THRESHOLD_MS,
  HEARTBEAT_TIMEOUT_MS,
  _checkAndMarkOffline,
} from "./presence.service.js";
import { UserRepository } from "../user/user.repository.js";
import { BROADCAST_CHANNEL } from "./presence.repository.js";
import logger from "../../shared/observability/logger.js";

const userRepo = new UserRepository();

const WORKER_INTERVAL_MS = 60_000;
const DB_SYNC_INTERVAL_MS = 5 * 60_000;

let workerTimer: ReturnType<typeof setInterval> | null = null;
let dbSyncTimer: ReturnType<typeof setInterval> | null = null;

export function startPresenceWorker(): void {
  logger.info("Presence worker starting");
  workerTimer = setInterval(() => void runEvaluation(), WORKER_INTERVAL_MS);
  dbSyncTimer = setInterval(() => void syncAllToDatabase(), DB_SYNC_INTERVAL_MS);
}

export function stopPresenceWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  if (dbSyncTimer) {
    clearInterval(dbSyncTimer);
    dbSyncTimer = null;
  }
  logger.info("Presence worker stopped");
}

/**
 * Must be called once after Redis connects and before the server starts
 * accepting connections.
 *
 * Steps:
 *  1. Clear all presence:user:*:sockets sets -- these contain socket IDs from
 *     the previous process which are now dead. Without this, users appear ONLINE
 *     forever after a server restart.
 *  2. Run the evaluation loop immediately so every user with a stale heartbeat
 *     is transitioned to OFFLINE right now (not in up to 60s).
 *  3. Sync the results to MongoDB so the DB reflects reality immediately.
 */
export async function cleanupOnStartup(): Promise<void> {
  logger.info("Presence worker running startup cleanup");
  try {
    await presenceRepo.clearAllSocketSets();
    await runEvaluation();
    await syncAllToDatabase();
    logger.info("Presence worker startup cleanup complete");
  } catch (err) {
    logger.error({ err }, "Presence worker startup cleanup error");
  }
}

async function runEvaluation(): Promise<void> {
  try {
    const userIds = await presenceRepo.getAllPresenceUserIds();
    if (userIds.length === 0) return;
    await Promise.allSettled(userIds.map(evaluateUser));
  } catch (err) {
    logger.error({ err }, "Presence worker evaluation error");
  }
}

async function evaluateUser(userId: string): Promise<void> {
  const [presence, socketCount, hasGrace] = await Promise.all([
    presenceRepo.getPresence(userId),
    presenceRepo.getSocketCount(userId),
    presenceRepo.hasGracePeriod(userId),
  ]);

  if (!presence) return;

  const now = Date.now();
  const lastActivity = new Date(presence.lastActivity).getTime();
  const lastHB = new Date(presence.lastHeartbeat).getTime();

  // Rule 1: ONLINE -> AWAY (idle but still connected)
  if (presence.status === "ONLINE" && now - lastActivity > ONLINE_THRESHOLD_MS && socketCount > 0) {
    await presenceRepo.setPresenceFields(userId, { status: "AWAY" });
    await presenceRepo.publish(
      BROADCAST_CHANNEL,
      JSON.stringify({ event: "USER_AWAY", userId, status: "AWAY", activeDevices: socketCount })
    );
    return;
  }

  // Rule 2: -> OFFLINE (no sockets, stale heartbeat, grace expired)
  if (
    presence.status !== "OFFLINE" &&
    socketCount === 0 &&
    now - lastHB > HEARTBEAT_TIMEOUT_MS &&
    !hasGrace
  ) {
    await _checkAndMarkOffline(userId);
  }
}

async function syncAllToDatabase(): Promise<void> {
  try {
    const userIds = await presenceRepo.getAllPresenceUserIds();
    if (userIds.length === 0) return;

    await Promise.allSettled(
      userIds.map(async (userId: string) => {
        const [presence, socketCount] = await Promise.all([
          presenceRepo.getPresence(userId),
          presenceRepo.getSocketCount(userId),
        ]);
        if (!presence) return;

        const status = computeStatus(presence, socketCount);
        const lastSeen = status === "OFFLINE" ? new Date(presence.lastSeen) : undefined;
        await userRepo.syncPresenceToDb(userId, status, lastSeen);
      })
    );

    logger.info({ count: userIds.length }, "Presence worker synced user(s) to DB");
  } catch (err) {
    logger.error({ err }, "Presence worker DB sync error");
  }
}
