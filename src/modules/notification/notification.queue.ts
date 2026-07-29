/**
 * Fallback delivery queue for push notifications rejected while the FCM/APNs
 * circuit breaker was OPEN (spec §6.4: "Push falls back to queue (BullMQ)").
 *
 * Scoped per-device, not per-user: `notifyIncomingCall`/`notifyMissedCall`
 * fan out to every device a user has registered, and by the time the
 * breaker trips, some of those sends may have already succeeded. Re-running
 * the whole per-user notification would re-send to devices that already got
 * it — this queue only ever retries the specific device send that was
 * rejected.
 */
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { createDedicatedRedisConnection } from "../../shared/db/redis.client.js";
import { sendFcmNotification } from "./fcm.client.js";
import { sendApnsNotification, sendVoipPush } from "./apns.client.js";
import logger from "../../shared/observability/logger.js";

export interface PushFallbackJob {
  platform: "android" | "ios" | "web";
  token: string;
  isVoip: boolean;
  title: string;
  body: string;
  data: Record<string, string>;
}

const QUEUE_NAME = "push-fallback";
// Give the breaker's openDurationMs (120s, see fcm.client.ts/apns.client.ts)
// a chance to elapse before the first retry.
const RETRY_DELAY_MS = 120_000;
const MAX_QUEUE_ATTEMPTS = 3;

let queue: Queue<PushFallbackJob> | null = null;
let worker: Worker<PushFallbackJob> | null = null;
let queueConnection: Redis | null = null;
let workerConnection: Redis | null = null;

function getQueue(): Queue<PushFallbackJob> {
  if (!queue) {
    const connection = createDedicatedRedisConnection();
    queueConnection = connection;
    queue = new Queue(QUEUE_NAME, { connection });
  }
  return queue;
}

/** Enqueue a single device's push for later retry after it was rejected by an OPEN circuit breaker. */
export async function enqueuePushFallback(job: PushFallbackJob): Promise<void> {
  try {
    await getQueue().add("push", job, {
      delay: RETRY_DELAY_MS,
      attempts: MAX_QUEUE_ATTEMPTS,
      backoff: { type: "exponential", delay: RETRY_DELAY_MS },
      removeOnComplete: true,
      // Kept (not removed) so a persistently-failing device is visible in
      // BullMQ's failed set — the "dead-letter" spec §6.3 calls for.
      removeOnFail: false,
    });
  } catch (err) {
    logger.warn({ err, platform: job.platform }, "Failed to enqueue push fallback job");
  }
}

async function handlePushFallback(job: Job<PushFallbackJob>): Promise<void> {
  const { platform, token, isVoip, title, body, data } = job.data;

  const result =
    platform === "ios"
      ? isVoip
        ? await sendVoipPush(token, data)
        : await sendApnsNotification({
            deviceToken: token,
            pushType: "alert",
            aps: { alert: { title, body }, sound: "default" },
            data,
          })
      : await sendFcmNotification({ token, title, body, data });

  if (!result.ok) {
    // Permanent failures (dead token) are not worth retrying further, but
    // still need to fail the job so it's counted in BullMQ's dead-letter set
    // rather than silently vanishing via removeOnComplete.
    throw new Error(
      result.permanentFailure ? "Push fallback: token permanently invalid" : "Push fallback delivery failed"
    );
  }
}

export function startPushFallbackWorker(): Worker<PushFallbackJob> {
  if (worker) return worker;

  const connection = createDedicatedRedisConnection();
  workerConnection = connection;
  worker = new Worker(QUEUE_NAME, handlePushFallback, { connection });
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, platform: job?.data?.platform, err }, "Push fallback job failed (dead-letter)");
  });

  return worker;
}

export async function stopPushFallbackWorker(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
  await workerConnection?.quit();
  workerConnection = null;
  await queueConnection?.quit();
  queueConnection = null;
}
