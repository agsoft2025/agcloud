/**
 * 60-second unanswered-call timeout, via a BullMQ delayed job.
 *
 * A delayed job (not `setTimeout`) survives process restarts and works
 * correctly with multiple server instances — whichever instance's worker
 * picks up the job when it fires re-checks the call's current status before
 * acting, so a call that was accepted/rejected/cancelled in the meantime is
 * a no-op.
 */
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { createDedicatedRedisConnection } from "../../shared/db/redis.client.js";
import { CallRepository } from "./call.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { endLiveKitRoom } from "../livekit/livekit.service.js";
import { emitToUser } from "../realtime/realtime.service.js";
import { notifyMissedCall } from "../notification/notification.service.js";
import { callsMissed } from "../../shared/observability/metrics.js";
import logger from "../../shared/observability/logger.js";

const QUEUE_NAME = "call-timeout";
const TIMEOUT_MS = 60_000;

const callRepo = new CallRepository();
const userRepo = new UserRepository();

let queue: Queue<{ callId: string }> | null = null;
let worker: Worker<{ callId: string }> | null = null;
let queueConnection: Redis | null = null;
let workerConnection: Redis | null = null;

function getQueue(): Queue<{ callId: string }> {
  if (!queue) {
    // BullMQ issues blocking commands (BRPOPLPUSH etc.) that must not share a
    // connection with the rest of the app's Redis usage (pub/sub, caching),
    // so it gets its own dedicated ioredis connection.
    const connection = createDedicatedRedisConnection();
    queueConnection = connection;
    queue = new Queue(QUEUE_NAME, { connection });
  }
  return queue;
}

/** Schedule the 60s auto-missed check for a freshly-initiated call. */
export async function scheduleCallTimeout(callId: string): Promise<void> {
  try {
    await getQueue().add(
      "timeout",
      { callId },
      {
        delay: TIMEOUT_MS,
        jobId: callId,
        removeOnComplete: true,
        removeOnFail: true,
      }
    );
  } catch (err) {
    logger.warn({ err, callId }, "Failed to schedule call timeout job");
  }
}

/** Cancel a pending timeout once the call leaves "initiated" (accepted/rejected/cancelled/ended). */
export async function cancelCallTimeout(callId: string): Promise<void> {
  try {
    const job = await getQueue().getJob(callId);
    if (job) await job.remove();
  } catch (err) {
    logger.warn({ err, callId }, "Failed to cancel call timeout job");
  }
}

async function handleTimeout(job: Job<{ callId: string }>): Promise<void> {
  const { callId } = job.data;
  const call = await callRepo.getCallById(callId);

  // Already accepted, rejected, cancelled, or ended — nothing to do.
  if (!call || call.status !== "initiated") return;

  await callRepo.updateCallStatus(callId, "missed");
  await callRepo.markPendingParticipantsAs(callId, "missed");
  await endLiveKitRoom(call.roomId || callId);
  callsMissed.inc();

  const caller = await userRepo.getUserById(call.callerId);
  const participantIds = new Set([call.callerId, ...call.receiverIds]);
  for (const participantId of participantIds) {
    emitToUser(participantId, "call:missed", { callId });
  }

  for (const receiverId of call.receiverIds) {
    notifyMissedCall(receiverId, {
      callId,
      callerName: caller?.displayName ?? "Unknown",
    }).catch((err: unknown) => logger.warn({ err, receiverId }, "Missed-call push failed"));
  }

  logger.info({ callId }, "Call auto-timed-out after 60s unanswered");
}

export function startCallTimeoutWorker(): Worker<{ callId: string }> {
  if (worker) return worker;

  const connection = createDedicatedRedisConnection();
  workerConnection = connection;
  worker = new Worker(QUEUE_NAME, handleTimeout, { connection });
  worker.on("failed", (job, err) => {
    logger.error({ callId: job?.data?.callId, err }, "Call timeout job failed");
  });

  return worker;
}

export async function stopCallTimeoutWorker(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
  await workerConnection?.quit();
  workerConnection = null;
  await queueConnection?.quit();
  queueConnection = null;
}
