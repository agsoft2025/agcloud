import { ObjectId } from "mongodb";
import { z } from "zod";

// ── Documents ─────────────────────────────────────────────────────────────────

export interface SubscriptionPlanDocument {
  _id: ObjectId;
  name: string;
  durationMonths: 1 | 3 | 6 | 12;
  price: number;        // INR
  currency: "INR";
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserSubscriptionDocument {
  _id: ObjectId;
  userId: string;
  planId: string;
  planName: string;
  durationMonths: number;
  amount: number;       // INR (not paise)
  currency: "INR";
  status: "pending" | "active" | "expired" | "cancelled";
  startDate: Date | null;
  endDate: Date | null;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  razorpaySignature: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

export const createPlanSchema = z.object({
  name:           z.string().min(1).max(80),
  durationMonths: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
  price:          z.number().positive(),
});

export const updatePlanSchema = z.object({
  name:     z.string().min(1).max(80).optional(),
  price:    z.number().positive().optional(),
  isActive: z.boolean().optional(),
});

export const createOrderSchema = z.object({
  planId: z.string().min(1),
});

export const verifyPaymentSchema = z.object({
  razorpayOrderId:   z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});
