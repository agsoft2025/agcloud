import { z } from "zod";
import { ObjectId } from "mongodb";

export const pricingRateSchema = z.object({
  callType:      z.enum(["audio", "video"]),
  ratePerMinute: z.number().positive("Rate must be positive").finite(),
  currency:      z.string().length(3, "Must be a 3-letter ISO code").default("INR"),
  effectiveFrom: z.coerce.date(),
  label:         z.string().max(120).optional(),
  createdBy:     z.string(),
  createdAt:     z.date().default(() => new Date()),
});

export type PricingRate = z.infer<typeof pricingRateSchema>;

export interface PricingRateDocument extends PricingRate {
  _id: ObjectId;
}

/** Admin: create a new rate */
export const createRateSchema = z.object({
  callType:      z.enum(["audio", "video"]),
  ratePerMinute: z.number().positive().finite(),
  currency:      z.string().length(3).default("INR"),
  effectiveFrom: z.coerce.date(),
  label:         z.string().max(120).optional(),
});

/** Admin: update an existing rate */
export const updateRateSchema = z
  .object({
    ratePerMinute: z.number().positive().finite().optional(),
    effectiveFrom: z.coerce.date().optional(),
    label:         z.string().max(120).optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), "No updatable fields provided");
