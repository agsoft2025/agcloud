import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Db } from "mongodb";
import { CallRepository } from "../call/call.repository.js";
import { PricingRepository } from "../pricing/pricing.repository.js";
import { BillingRepository } from "../billing/billing.repository.js";
import { BillingSettingsRepository } from "../billing/billing-settings.repository.js";
import { SubscriptionPlanRepository } from "../subscription/subscription-plan.repository.js";
import { UserSubscriptionRepository } from "../subscription/user-subscription.repository.js";
import { UserFreeCallRepository } from "../billing/user-free-call.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { createRateSchema, updateRateSchema } from "../pricing/pricing.schemas.js";
import type { PricingRateDocument } from "../pricing/pricing.schemas.js";
import { createPlanSchema, updatePlanSchema } from "../subscription/subscription.schemas.js";
import type { SubscriptionPlanDocument } from "../subscription/subscription.schemas.js";
import { getActiveRates } from "../pricing/pricing.service.js";
import { authenticate, requireRole } from "../../shared/middleware/auth.middleware.js";
import { writeAuditLog } from "../../shared/security/audit-log.js";

const billingSettingsSchema = z.object({
  freeMinutes:        z.number().int().min(1).max(60),
  gracePeriodSeconds: z.number().int().min(10).max(300),
});

const adminRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const callRepo            = new CallRepository();
  const pricingRepo         = new PricingRepository();
  const billingRepo         = new BillingRepository();
  const billingSettingsRepo = new BillingSettingsRepository();
  const subPlanRepo         = new SubscriptionPlanRepository();
  const userSubRepo         = new UserSubscriptionRepository();
  const freeCallRepo        = new UserFreeCallRepository();
  const userRepo            = new UserRepository();

  // ── Enriched user list ────────────────────────────────────────────────────
  //
  // GET /admin/users/enriched
  // Returns all users with their latest subscription and call-usage stats in
  // one response. Uses three batch queries (no N+1): one for call_charges, one
  // for user_subscriptions, one for user_free_call_usage.

  app.get(
    "/users/enriched",
    { preHandler: [authenticate, requireRole("admin")] },
    async (_request, reply) => {
      // ── Batch-fetch all data in one parallel round trip ───────────────────
      const now = new Date();
      const [users, durationMap, subMap, rates] = await Promise.all([
        userRepo.findAll(),
        callRepo.findDurationGroupedByCaller(),   // from `calls` collection — accurate for all users
        userSubRepo.findLatestPerUser(),
        getActiveRates(now),                       // current audio + video ₹/min rates
      ]);

      // Fetch free-call usage for all user IDs in one query.
      const userIds = users.map((u) => u._id.toString());
      const { connectMongo } = await import("../../shared/db/mongo.client.js");
      const db = await connectMongo();
      const freeCallDocs = await db
        .collection<{ userId: string; used: boolean }>("user_free_call_usage")
        .find({ userId: { $in: userIds } })
        .toArray();
      const freeCallMap = new Map<string, boolean>(
        freeCallDocs.map((d) => [d.userId, d.used]),
      );

      // ── Current pricing rates (₹/min) ─────────────────────────────────────
      const audioRate = rates.audio?.ratePerMinute ?? 0;
      const videoRate = rates.video?.ratePerMinute ?? 0;

      const enriched = users.map((u) => {
        const uid      = u._id.toString();
        const dur      = durationMap.get(uid) ?? { audioSeconds: 0, videoSeconds: 0 };
        const sub      = subMap.get(uid) ?? null;
        const freeUsed = freeCallMap.get(uid) ?? false;

        // Actual minutes (raw, not capped to billable seconds)
        const audioMinutes = dur.audioSeconds / 60;
        const videoMinutes = dur.videoSeconds / 60;

        // ₹ spent at current rates
        const amountUsed =
          Math.round((audioMinutes * audioRate + videoMinutes * videoRate) * 100) / 100;

        // Remaining balance only makes sense when the user has paid for a subscription
        const subscriptionAmount = sub?.amount ?? null;
        const remainingBalance =
          subscriptionAmount !== null
            ? Math.max(0, Math.round((subscriptionAmount - amountUsed) * 100) / 100)
            : null;

        // Remaining call time given the balance and current rates
        const remainingAudioMinutes =
          remainingBalance !== null && audioRate > 0
            ? Math.max(0, Math.floor(remainingBalance / audioRate))
            : null;
        const remainingVideoMinutes =
          remainingBalance !== null && videoRate > 0
            ? Math.max(0, Math.floor(remainingBalance / videoRate))
            : null;

        const isActiveSubscriber =
          sub !== null &&
          sub.status === "active" &&
          sub.endDate !== null &&
          sub.endDate > now;

        return {
          id:          uid,
          email:       u.email,
          displayName: u.displayName,
          avatarUrl:   u.avatarUrl ?? null,
          role:        u.role,
          status:      u.status,
          createdAt:   u.createdAt.toISOString(),
          subscription: sub
            ? {
                planName:       sub.planName,
                durationMonths: sub.durationMonths,
                status:         isActiveSubscriber ? "active" : sub.status,
                startDate:      sub.startDate?.toISOString() ?? null,
                endDate:        sub.endDate?.toISOString()   ?? null,
                amount:         sub.amount,
                currency:       sub.currency,
              }
            : null,
          usage: {
            audioSeconds:     dur.audioSeconds,
            videoSeconds:     dur.videoSeconds,
            audioMinutes:     Math.round(audioMinutes * 100) / 100,
            videoMinutes:     Math.round(videoMinutes * 100) / 100,
            audioRate,        // ₹/min
            videoRate,        // ₹/min
            amountUsed,       // ₹ spent at current rates
            remainingBalance, // ₹ left (null if no subscription)
            remainingAudioMinutes,  // minutes of audio left (null if no sub)
            remainingVideoMinutes,  // minutes of video left (null if no sub)
          },
          freeCallUsed: freeUsed,
        };
      });

      return reply.send({ users: enriched, total: enriched.length });
    },
  );

  // ── User report helpers ──────────────────────────────────────────────────
  //
  // Shared call-enrichment logic used by both the paginated report endpoint
  // and the full export endpoint. Fetches peer user names + charge amounts in
  // two batch queries (no N+1).

  async function enrichCallDocs(
    rawCalls: Record<string, unknown>[],
    userId: string,
    userEmail: string,
    userDisplayName: string,
    db: Db,
  ) {
    if (rawCalls.length === 0) return [];

    // Collect unique peer IDs
    const peerIdSet = new Set<string>();
    for (const call of rawCalls) {
      const cid = call.callerId as string | undefined;
      if (cid && cid !== userId) peerIdSet.add(cid);
      for (const rid of (call.receiverIds ?? []) as string[]) {
        if (rid !== userId) peerIdSet.add(rid);
      }
    }

    // Batch-fetch peer names
    const peerDocs = await userRepo.findManyByIds([...peerIdSet]);
    const peerMap  = new Map<string, { email: string; displayName: string }>();
    peerMap.set(userId, { email: userEmail, displayName: userDisplayName });
    for (const p of peerDocs) {
      peerMap.set(p._id.toString(), { email: p.email, displayName: p.displayName ?? "" });
    }

    // Batch-fetch charge records
    const callIds   = rawCalls.map((c: Record<string, unknown>) => (c._id as { toString(): string }).toString());
    const chargeDocs = await db
      .collection("call_charges")
      .find({ callId: { $in: callIds } })
      .toArray();
    const chargeMap = new Map<string, number>();
    for (const ch of chargeDocs) {
      chargeMap.set(ch.callId as string, ch.amountOwed as number);
    }

    return rawCalls.map((call: Record<string, unknown>) => {
      const cid = (call._id as { toString(): string }).toString();
      const dur =
        call.startedAt && call.endedAt
          ? Math.max(
              0,
              Math.round(
                ((call.endedAt as Date).getTime() - (call.startedAt as Date).getTime()) / 1000,
              ),
            )
          : 0;
      const caller = peerMap.get(call.callerId as string) ?? {
        email: (call.callerId as string) ?? "",
        displayName: "",
      };
      const receivers = ((call.receiverIds ?? []) as string[]).map((rid) => {
        const u = peerMap.get(rid) ?? { email: rid, displayName: "" };
        return { userId: rid, email: u.email, displayName: u.displayName };
      });
      return {
        id:              cid,
        callType:        call.callType  as string,
        callMode:        call.callMode  as string,
        status:          call.status    as string,
        durationSeconds: dur,
        createdAt:       (call.createdAt as Date | null)?.toISOString() ?? null,
        startedAt:       (call.startedAt as Date | null)?.toISOString() ?? null,
        endedAt:         (call.endedAt   as Date | null)?.toISOString() ?? null,
        callerId:        call.callerId as string,
        callerEmail:     caller.email,
        callerName:      caller.displayName,
        receivers,
        amountCharged:   chargeMap.get(cid) ?? null,  // null = subscribed/not billed
      };
    });
  }

  // ── User report (paginated) ───────────────────────────────────────────────
  //
  // GET /admin/reports/user/:userId?page=1&limit=20&callType=audio&status=ended
  // Returns paginated call history + all subscriptions for a user.
  // Subscriptions are not paginated (users rarely have many).

  app.get(
    "/reports/user/:userId",
    { preHandler: [authenticate, requireRole("admin")] },
    async (request, reply) => {
      const { userId } = request.params as { userId: string };
      const q = request.query as {
        page?: string; limit?: string; callType?: string; status?: string;
      };

      const page  = Math.max(1, parseInt(q.page  ?? "1",  10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? "20", 10) || 20));
      const skip  = (page - 1) * limit;

      const user = await userRepo.getUserById(userId);
      if (!user) return reply.status(404).send({ message: "User not found" });

      const { connectMongo } = await import("../../shared/db/mongo.client.js");
      const db = await connectMongo();

      // Build call filter — always scoped to this user
      const callFilter: Record<string, unknown> = {
        $or: [{ callerId: userId }, { receiverIds: userId }],
      };
      if (q.callType) callFilter.callType = q.callType;
      if (q.status)   callFilter.status   = q.status;

      const callsCol = db.collection("calls");

      const [subscriptions, totalCalls, rawCalls] = await Promise.all([
        userSubRepo.findAllByUserId(userId),
        callsCol.countDocuments(callFilter),
        callsCol
          .find(callFilter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
      ]);

      const calls = await enrichCallDocs(
        rawCalls as unknown as Record<string, unknown>[],
        userId,
        user.email,
        user.displayName ?? "",
        db,
      );

      return reply.send({
        user: {
          id:          userId,
          email:       user.email,
          displayName: user.displayName ?? "",
          avatarUrl:   user.avatarUrl ?? null,
          role:        user.role,
          status:      user.status,
          createdAt:   user.createdAt.toISOString(),
        },
        subscriptions: subscriptions.map((s) => ({
          id:             s._id.toString(),
          planName:       s.planName,
          durationMonths: s.durationMonths,
          amount:         s.amount,
          currency:       s.currency,
          status:         s.status,
          startDate:      s.startDate?.toISOString() ?? null,
          endDate:        s.endDate?.toISOString()   ?? null,
          createdAt:      (s as unknown as { createdAt?: Date }).createdAt?.toISOString() ?? null,
        })),
        calls,
        totalCalls,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(totalCalls / limit)),
      });
    },
  );

  // ── User report export (all records, for CSV download) ────────────────────
  //
  // GET /admin/reports/user/:userId/export
  // Returns every call + subscription for the user (up to 5 000 calls).
  // Used exclusively by the frontend Download History button — do NOT paginate.

  app.get(
    "/reports/user/:userId/export",
    { preHandler: [authenticate, requireRole("admin")] },
    async (request, reply) => {
      const { userId } = request.params as { userId: string };

      const user = await userRepo.getUserById(userId);
      if (!user) return reply.status(404).send({ message: "User not found" });

      const { connectMongo } = await import("../../shared/db/mongo.client.js");
      const db = await connectMongo();

      const [subscriptions, rawCalls] = await Promise.all([
        userSubRepo.findAllByUserId(userId),
        db
          .collection("calls")
          .find({ $or: [{ callerId: userId }, { receiverIds: userId }] })
          .sort({ createdAt: -1 })
          .limit(5000)
          .toArray(),
      ]);

      const calls = await enrichCallDocs(
        rawCalls as unknown as Record<string, unknown>[],
        userId,
        user.email,
        user.displayName ?? "",
        db,
      );

      return reply.send({
        user: {
          id:          userId,
          email:       user.email,
          displayName: user.displayName ?? "",
          avatarUrl:   user.avatarUrl ?? null,
          role:        user.role,
          status:      user.status,
          createdAt:   user.createdAt.toISOString(),
        },
        subscriptions: subscriptions.map((s) => ({
          id:             s._id.toString(),
          planName:       s.planName,
          durationMonths: s.durationMonths,
          amount:         s.amount,
          currency:       s.currency,
          status:         s.status,
          startDate:      s.startDate?.toISOString() ?? null,
          endDate:        s.endDate?.toISOString()   ?? null,
          createdAt:      (s as unknown as { createdAt?: Date }).createdAt?.toISOString() ?? null,
        })),
        calls,
        totalCalls: calls.length,
      });
    },
  );

  // ── Active calls ─────────────────────────────────────────────────────────

  // GET /admin/calls/active — every call currently ringing or in progress
  app.get(
    "/calls/active",
    { preHandler: [authenticate, requireRole("admin")] },
    async (request, reply) => {
      const query = request.query as { page?: string; limit?: string };
      const page  = Math.max(1, parseInt(query.page  ?? "1",  10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? "20", 10) || 20));

      const { calls, total } = await callRepo.getActiveCalls(page, limit);

      await writeAuditLog({
        event:     "admin.calls_active.viewed",
        severity:  "info",
        userId:    request.user?.userId,
        email:     request.user?.email,
        ip:        request.ip ?? null,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
        metadata:  { page, limit, resultCount: calls.length, total },
      });

      return reply.send({
        calls: calls.map((call) => ({
          id:         call._id.toString(),
          callerId:   call.callerId,
          calleeId:   call.calleeId,
          receiverIds: call.receiverIds,
          callType:   call.callType,
          callMode:   call.callMode,
          status:     call.status,
          recording:  call.recording,
          roomId:     call.roomId,
          createdAt:  call.createdAt?.toISOString(),
          startedAt:  call.startedAt?.toISOString(),
        })),
        total,
        page,
        limit,
      });
    },
  );

  // ── Pricing: admin CRUD ───────────────────────────────────────────────────

  const fmtRate = (r: PricingRateDocument) => ({
    id:            r._id.toString(),
    callType:      r.callType,
    ratePerMinute: r.ratePerMinute,
    currency:      r.currency,
    effectiveFrom: r.effectiveFrom.toISOString(),
    label:         r.label || null,  // normalize "" and undefined → null
    createdBy:     r.createdBy,
    createdAt:     r.createdAt.toISOString(),
  });

  // GET /admin/pricing — all rate schedules, sorted by type + date
  app.get(
    "/pricing",
    { preHandler: [authenticate, requireRole("admin")] },
    async (_request, reply) => {
      const rates = await pricingRepo.findAll();
      return reply.send({ rates: rates.map(fmtRate) });
    },
  );

  // GET /admin/pricing/active — currently-active rate per call type
  app.get(
    "/pricing/active",
    { preHandler: [authenticate, requireRole("admin")] },
    async (_request, reply) => {
      const now = new Date();
      const [audio, video] = await Promise.all([
        pricingRepo.findActiveRate("audio", now),
        pricingRepo.findActiveRate("video", now),
      ]);
      const fmt = (r: PricingRateDocument | null) =>
        r ? { id: r._id.toString(), ratePerMinute: r.ratePerMinute, currency: r.currency, effectiveFrom: r.effectiveFrom.toISOString() } : null;
      return reply.send({ audio: fmt(audio), video: fmt(video) });
    },
  );

  // POST /admin/pricing — create a new rate (immediate or scheduled)
  app.post(
    "/pricing",
    { preHandler: [authenticate, requireRole("admin")] },
    async (request, reply) => {
      let body: z.infer<typeof createRateSchema>;
      try {
        body = createRateSchema.parse(request.body);
      } catch (err) {
        if (err instanceof z.ZodError)
          return reply.status(400).send({ message: "Validation failed", errors: err.issues });
        throw err;
      }
      const rate = await pricingRepo.create({
        callType:      body.callType,
        ratePerMinute: body.ratePerMinute,
        currency:      body.currency,
        effectiveFrom: body.effectiveFrom,
        label:         body.label,
        createdBy:     request.user!.userId,
        createdAt:     new Date(),
      });
      return reply.status(201).send(fmtRate(rate));
    },
  );

  // PUT /admin/pricing/:id — update ratePerMinute, effectiveFrom, or label
  app.put(
    "/pricing/:id",
    { preHandler: [authenticate, requireRole("admin")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      let body: z.infer<typeof updateRateSchema>;
      try {
        body = updateRateSchema.parse(request.body);
      } catch (err) {
        if (err instanceof z.ZodError)
          return reply.status(400).send({ message: "Validation failed", errors: err.issues });
        throw err;
      }
      const updates: Partial<Pick<PricingRateDocument, "ratePerMinute" | "effectiveFrom" | "label">> = {};
      if (body.ratePerMinute !== undefined) updates.ratePerMinute = body.ratePerMinute;
      if (body.effectiveFrom !== undefined) updates.effectiveFrom = body.effectiveFrom;
      if (body.label         !== undefined) updates.label         = body.label;
      const updated = await pricingRepo.update(id, updates);
      if (!updated) return reply.status(404).send({ message: "Rate not found" });
      return reply.send(fmtRate(updated));
    },
  );

  // DELETE /admin/pricing/:id — remove a rate schedule
  app.delete(
    "/pricing/:id",
    { preHandler: [authenticate, requireRole("admin")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await pricingRepo.delete(id);
      if (!deleted) return reply.status(404).send({ message: "Rate not found" });
      return reply.send({ message: "Rate deleted" });
    },
  );

  // ── Billing: admin read-only ──────────────────────────────────────────────
  // Admins can VIEW charge records but cannot manually modify amounts or balances.

  // GET /admin/billing — paginated charge history
  app.get(
    "/billing",
    { preHandler: [authenticate, requireRole("admin")] },
    async (request, reply) => {
      const q     = request.query as { page?: string; limit?: string };
      const page  = Math.max(1, parseInt(q.page  ?? "1",  10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? "20", 10) || 20));
      const { charges, total } = await billingRepo.findAll(page, limit);
      return reply.send({
        charges: charges.map((c) => ({
          id:              c._id.toString(),
          callId:          c.callId,
          callerId:        c.callerId,
          calleeIds:       c.calleeIds,
          callType:        c.callType,
          durationSeconds: c.durationSeconds,
          freeSeconds:     c.freeSeconds,
          billableSeconds: c.billableSeconds,
          ratePerMinute:   c.ratePerMinute,
          amountOwed:      c.amountOwed,
          currency:        c.currency,
          status:          c.status,
          createdAt:       c.createdAt.toISOString(),
        })),
        total,
        page,
        limit,
      });
    },
  );

  // ── Billing settings ─────────────────────────────────────────────────────
  // Admins can read and update free-minute / grace-period config.
  // Admins CANNOT manually modify individual user charge records.

  // GET /admin/billing/settings
  app.get(
    "/billing/settings",
    { preHandler: [authenticate, requireRole("admin")] },
    async (_request, reply) => {
      const settings = await billingSettingsRepo.getSettings();
      return reply.send(settings);
    },
  );

  // PUT /admin/billing/settings
  app.put(
    "/billing/settings",
    { preHandler: [authenticate, requireRole("admin")] },
    async (request, reply) => {
      let body: z.infer<typeof billingSettingsSchema>;
      try {
        body = billingSettingsSchema.parse(request.body);
      } catch (err) {
        if (err instanceof z.ZodError)
          return reply.status(400).send({ message: "Validation failed", errors: err.issues });
        throw err;
      }
      const updated = await billingSettingsRepo.updateSettings(body);
      return reply.send(updated);
    },
  );
  // ── Subscription plans: admin CRUD ───────────────────────────────────────
  // Admins manage plan definitions; users subscribe via /subscriptions routes.

  const fmtPlan = (p: SubscriptionPlanDocument) => ({
    id:             p._id.toString(),
    name:           p.name,
    durationMonths: p.durationMonths,
    price:          p.price,
    currency:       p.currency,
    isActive:       p.isActive,
    createdAt:      p.createdAt.toISOString(),
    updatedAt:      p.updatedAt.toISOString(),
  });

  // GET /admin/subscription-plans — list all plans
  app.get(
    "/subscription-plans",
    { preHandler: [authenticate, requireRole("admin")] },
    async (_request, reply) => {
      const plans = await subPlanRepo.findAll();
      return reply.send({ plans: plans.map(fmtPlan) });
    },
  );

  // POST /admin/subscription-plans — create a plan
  app.post(
    "/subscription-plans",
    { preHandler: [authenticate, requireRole("admin")] },
    async (request, reply) => {
      let body: import("zod").infer<typeof createPlanSchema>;
      try {
        body = createPlanSchema.parse(request.body);
      } catch (err) {
        if (err instanceof z.ZodError)
          return reply.status(400).send({ message: "Validation failed", errors: err.issues });
        throw err;
      }
      const now = new Date();
      const plan = await subPlanRepo.create({
        name:           body.name,
        durationMonths: body.durationMonths,
        price:          body.price,
        currency:       "INR",
        isActive:       true,
        createdAt:      now,
        updatedAt:      now,
      });
      return reply.status(201).send(fmtPlan(plan));
    },
  );

  // PUT /admin/subscription-plans/:id — update name, price, or isActive
  app.put(
    "/subscription-plans/:id",
    { preHandler: [authenticate, requireRole("admin")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      let body: import("zod").infer<typeof updatePlanSchema>;
      try {
        body = updatePlanSchema.parse(request.body);
      } catch (err) {
        if (err instanceof z.ZodError)
          return reply.status(400).send({ message: "Validation failed", errors: err.issues });
        throw err;
      }
      const updates: Parameters<typeof subPlanRepo.update>[1] = { updatedAt: new Date() };
      if (body.name     !== undefined) updates.name     = body.name;
      if (body.price    !== undefined) updates.price    = body.price;
      if (body.isActive !== undefined) updates.isActive = body.isActive;
      const updated = await subPlanRepo.update(id, updates);
      if (!updated) return reply.status(404).send({ message: "Plan not found" });
      return reply.send(fmtPlan(updated));
    },
  );

  // DELETE /admin/subscription-plans/:id — remove a plan
  app.delete(
    "/subscription-plans/:id",
    { preHandler: [authenticate, requireRole("admin")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await subPlanRepo.delete(id);
      if (!deleted) return reply.status(404).send({ message: "Plan not found" });
      return reply.send({ message: "Plan deleted" });
    },
  );
};

export default adminRoutes;
