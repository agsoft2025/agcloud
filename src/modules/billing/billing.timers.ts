/**
 * billing.timers.ts
 *
 * In-process timers enforcing the free-minute / grace-period billing rules.
 * Settings (freeMinutes, gracePeriodSeconds) are fetched from the DB by the
 * caller (call.routes.ts) so they are always up-to-date without a DB hit here.
 *
 * NOTE: Timer state is per-process. In a horizontally-scaled deployment
 * replace this with a Redis-backed scheduler (e.g. BullMQ delayed jobs).
 */

import { emitToUser } from "../realtime/realtime.service.js";
import logger from "../../shared/observability/logger.js";

export interface BillingTimerOptions {
  freeSeconds:        number; // e.g. freeMinutes * 60
  gracePeriodSeconds: number;
}

interface BillingTimerHandle {
  warningTimer: ReturnType<typeof setTimeout>;
  cutoffTimer:  ReturnType<typeof setTimeout>;
  options:      BillingTimerOptions;
}

const timers = new Map<string, BillingTimerHandle>();

/**
 * Schedule warning + cutoff timers for a newly-active call.
 * Safe to call multiple times — cancels previous timers first.
 */
export function scheduleBillingTimers(
  callId:         string,
  participantIds: string[],
  onCutoff:       () => Promise<void>,
  options:        BillingTimerOptions,
): void {
  cancelBillingTimers(callId);

  const { freeSeconds, gracePeriodSeconds } = options;

  const warningTimer = setTimeout(() => {
    logger.info({ callId }, "Billing: free period ended — notifying participants");
    for (const userId of participantIds) {
      emitToUser(userId, "call:billing:warning", {
        callId,
        gracePeriodSeconds,
        message: "Your free call limit is over. Please subscribe to continue.",
      });
    }
  }, freeSeconds * 1_000);

  const cutoffTimer = setTimeout(async () => {
    logger.info({ callId }, "Billing: grace period expired — ending call");
    timers.delete(callId);
    for (const userId of participantIds) {
      emitToUser(userId, "call:billing:ended", { callId });
    }
    try {
      await onCutoff();
    } catch (err) {
      logger.error({ err, callId }, "Billing cutoff handler failed");
    }
  }, (freeSeconds + gracePeriodSeconds) * 1_000);

  timers.set(callId, { warningTimer, cutoffTimer, options });
  logger.info({ callId, freeSeconds, gracePeriodSeconds }, "Billing timers scheduled");
}

/** Cancel both timers for a call that ended normally before cutoff. */
export function cancelBillingTimers(callId: string): void {
  const handle = timers.get(callId);
  if (!handle) return;
  clearTimeout(handle.warningTimer);
  clearTimeout(handle.cutoffTimer);
  timers.delete(callId);
}

/** Return the timer options stored when scheduling (for charge calculation at call end). */
export function getBillingTimerOptions(callId: string): BillingTimerOptions | null {
  return timers.get(callId)?.options ?? null;
}
