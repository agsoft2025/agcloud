import { BillingRepository } from "./billing.repository.js";
import { BillingSettingsRepository } from "./billing-settings.repository.js";
import { getActiveRate } from "../pricing/pricing.service.js";
import logger from "../../shared/observability/logger.js";

const repo         = new BillingRepository();
const settingsRepo = new BillingSettingsRepository();

/**
 * Calculate charges for a completed call and persist a charge record.
 *
 * Rules:
 *  - First freeSeconds are always free (fetched from billing_settings; default 60 s / 1 min).
 *  - Time beyond that is billed at the rate active when the call started.
 *  - If no rate is configured, no charge is recorded.
 *  - Idempotent: a second call for the same callId is a no-op.
 *
 * @param freeSecondsOverride  If supplied (e.g. from the timer options stored at call-accept
 *                              time), use this value instead of fetching from the DB.
 *                              This preserves the setting that was in effect when the call started.
 */
export async function calculateAndSaveCharge(
  callId: string,
  {
    callerId,
    calleeIds,
    callType,
    startedAt,
    endedAt,
    freeSecondsOverride,
  }: {
    callerId:            string;
    calleeIds:           string[];
    callType:            "audio" | "video";
    startedAt:           Date;
    endedAt:             Date;
    freeSecondsOverride?: number;
  },
): Promise<void> {
  try {
    // Resolve freeSeconds: prefer the value captured at call-accept time
    let freeSeconds: number;
    if (freeSecondsOverride !== undefined) {
      freeSeconds = freeSecondsOverride;
    } else {
      const settings = await settingsRepo.getSettings();
      freeSeconds = settings.freeMinutes * 60;
    }

    const durationSeconds = Math.max(
      0,
      Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    );

    if (durationSeconds <= freeSeconds) return; // entirely within free period

    const existing = await repo.findByCallId(callId);
    if (existing) return; // idempotent

    const rate = await getActiveRate(callType, startedAt);
    if (!rate) {
      logger.info({ callId, callType }, "No pricing rate configured — skipping charge");
      return;
    }

    const billableSeconds = durationSeconds - freeSeconds;
    const amountOwed = Math.round(((billableSeconds / 60) * rate.ratePerMinute) * 100) / 100;

    await repo.create({
      callId,
      callerId,
      calleeIds,
      callType,
      durationSeconds,
      freeSeconds,
      billableSeconds,
      ratePerMinute: rate.ratePerMinute,
      amountOwed,
      currency: rate.currency,
      status: "pending",
      createdAt: new Date(),
    });

    logger.info({ callId, amountOwed, currency: rate.currency }, "Call charge recorded");
  } catch (err) {
    logger.error({ err, callId }, "calculateAndSaveCharge failed");
  }
}
