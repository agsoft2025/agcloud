/**
 * subscription.routes.ts
 *
 * User-facing subscription routes (prefix: /subscriptions).
 *
 * POST /subscriptions/create-order
 *   → Creates a Razorpay order and a pending UserSubscription record.
 *   → Returns orderId, amount (paise), currency, keyId for the frontend checkout.
 *
 * POST /subscriptions/verify-payment
 *   → Verifies the Razorpay HMAC signature.
 *   → Activates the subscription in the DB if valid.
 *
 * GET  /subscriptions/plans
 *   → Returns all active plans (no admin auth needed, any authenticated user).
 *
 * GET  /subscriptions/me
 *   → Returns the calling user's current (latest) subscription.
 */
import crypto from "crypto";
import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import Razorpay from "razorpay";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { SubscriptionPlanRepository } from "./subscription-plan.repository.js";
import { UserSubscriptionRepository } from "./user-subscription.repository.js";
import {
  createOrderSchema,
  verifyPaymentSchema,
} from "./subscription.schemas.js";
import config from "../../config/index.js";

const subscriptionRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const planRepo  = new SubscriptionPlanRepository();
  const subRepo   = new UserSubscriptionRepository();

  // Lazily initialise Razorpay so that missing keys don't crash the server
  // during tests / local dev without credentials; calls will 500 gracefully.
  function getRazorpay(): Razorpay {
    if (!config.razorpayKeyId || !config.razorpayKeySecret) {
      throw new Error("Razorpay credentials are not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).");
    }
    return new Razorpay({
      key_id:     config.razorpayKeyId,
      key_secret: config.razorpayKeySecret,
    });
  }

  // ── Helper ────────────────────────────────────────────────────────────────

  function fmtPlan(p: import("./subscription.schemas.js").SubscriptionPlanDocument) {
    return {
      id:             p._id.toString(),
      name:           p.name,
      durationMonths: p.durationMonths,
      price:          p.price,
      currency:       p.currency,
      isActive:       p.isActive,
      createdAt:      p.createdAt.toISOString(),
    };
  }

  function fmtSub(s: import("./subscription.schemas.js").UserSubscriptionDocument) {
    return {
      id:                 s._id.toString(),
      planId:             s.planId,
      planName:           s.planName,
      durationMonths:     s.durationMonths,
      amount:             s.amount,
      currency:           s.currency,
      status:             s.status,
      startDate:          s.startDate?.toISOString() ?? null,
      endDate:            s.endDate?.toISOString()   ?? null,
      razorpayOrderId:    s.razorpayOrderId,
      razorpayPaymentId:  s.razorpayPaymentId        ?? null,
      createdAt:          s.createdAt.toISOString(),
    };
  }

  // ── GET /subscriptions/plans ──────────────────────────────────────────────

  app.get(
    "/plans",
    { preHandler: [authenticate] },
    async (_request, reply) => {
      const plans = await planRepo.findActive();
      return reply.send({ plans: plans.map(fmtPlan) });
    },
  );

  // ── GET /subscriptions/me ─────────────────────────────────────────────────

  app.get(
    "/me",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = request.user!.userId;
      // Best-effort: expire overdue subscriptions; a DB hiccup must not block
      // the response — we just skip expiry silently and serve the latest state.
      try { await subRepo.expireOverdue(); } catch { /* non-fatal */ }
      const active  = await subRepo.findActiveByUserId(userId);
      const latest  = active ?? (await subRepo.findLatestByUserId(userId));
      return reply.send({ subscription: latest ? fmtSub(latest) : null });
    },
  );

  // ── POST /subscriptions/create-order ─────────────────────────────────────

  app.post(
    "/create-order",
    { preHandler: [authenticate] },
    async (request, reply) => {
      let body: z.infer<typeof createOrderSchema>;
      try {
        body = createOrderSchema.parse(request.body);
      } catch (err) {
        if (err instanceof z.ZodError)
          return reply.status(400).send({ message: "Validation failed", errors: err.issues });
        throw err;
      }

      const plan = await planRepo.findById(body.planId);
      if (!plan || !plan.isActive)
        return reply.status(404).send({ message: "Plan not found or inactive" });

      const razorpay = getRazorpay();
      const amountPaise = Math.round(plan.price * 100);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await (razorpay.orders as any).create({
        amount:   amountPaise,
        currency: "INR",
        receipt:  `sub_${request.user!.userId}_${Date.now()}`,
        notes: {
          userId: request.user!.userId,
          planId: plan._id.toString(),
        },
      });

      const now = new Date();
      await subRepo.create({
        userId:            request.user!.userId,
        planId:            plan._id.toString(),
        planName:          plan.name,
        durationMonths:    plan.durationMonths,
        amount:            plan.price,
        currency:          "INR",
        status:            "pending",
        startDate:         null,
        endDate:           null,
        razorpayOrderId:   order.id as string,
        razorpayPaymentId: null,
        razorpaySignature: null,
        createdAt:         now,
        updatedAt:         now,
      });

      return reply.status(201).send({
        orderId:  order.id,
        amount:   amountPaise,
        currency: "INR",
        keyId:    config.razorpayKeyId,
        planName: plan.name,
      });
    },
  );

  // ── POST /subscriptions/verify-payment ───────────────────────────────────

  app.post(
    "/verify-payment",
    { preHandler: [authenticate] },
    async (request, reply) => {
      let body: z.infer<typeof verifyPaymentSchema>;
      try {
        body = verifyPaymentSchema.parse(request.body);
      } catch (err) {
        if (err instanceof z.ZodError)
          return reply.status(400).send({ message: "Validation failed", errors: err.issues });
        throw err;
      }

      // Verify HMAC-SHA256 signature
      const expected = crypto
        .createHmac("sha256", config.razorpayKeySecret)
        .update(`${body.razorpayOrderId}|${body.razorpayPaymentId}`)
        .digest("hex");

      if (expected !== body.razorpaySignature)
        return reply.status(400).send({ message: "Invalid payment signature" });

      // Find the pending subscription record
      const pending = await subRepo.findByOrderId(body.razorpayOrderId);
      if (!pending)
        return reply.status(404).send({ message: "Order not found" });

      if (pending.userId !== request.user!.userId)
        return reply.status(403).send({ message: "Forbidden" });

      if (pending.status !== "pending")
        return reply.status(409).send({ message: "Order already processed" });

      // Calculate subscription window
      const startDate = new Date();
      const endDate   = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + pending.durationMonths);

      const activated = await subRepo.activate(pending._id, {
        razorpayPaymentId: body.razorpayPaymentId,
        razorpaySignature: body.razorpaySignature,
        startDate,
        endDate,
      });

      if (!activated)
        return reply.status(500).send({ message: "Failed to activate subscription" });

      return reply.send({ subscription: fmtSub(activated) });
    },
  );
};

export default subscriptionRoutes;
