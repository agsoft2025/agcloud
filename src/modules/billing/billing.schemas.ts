import { z } from "zod";
import { ObjectId } from "mongodb";

/** Free minutes every user receives at the start of each call. */
export const FREE_SECONDS = 300; // 5 minutes

/** Extra time after the free period before the call is force-ended. */
export const GRACE_PERIOD_SECONDS = 60; // 1 minute

export const callChargeSchema = z.object({
  callId:          z.string(),
  callerId:        z.string(),
  calleeIds:       z.array(z.string()),
  callType:        z.enum(["audio", "video"]),
  durationSeconds: z.number().nonnegative(),
  freeSeconds:     z.number().default(FREE_SECONDS),
  billableSeconds: z.number().nonnegative(),
  ratePerMinute:   z.number().nonnegative(),
  amountOwed:      z.number().nonnegative(),
  currency:        z.string().default("INR"),
  /** pending = awaiting payment; paid = settled; waived = admin override */
  status:          z.enum(["pending", "paid", "waived"]).default("pending"),
  createdAt:       z.date().default(() => new Date()),
});

export type CallCharge = z.infer<typeof callChargeSchema>;

export interface CallChargeDocument extends CallCharge {
  _id: ObjectId;
}
