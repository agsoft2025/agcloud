import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CallRepository } from "../call/call.repository.js";
import { PricingRepository } from "../pricing/pricing.repository.js";
import { BillingRepository } from "../billing/billing.repository.js";
import { BillingSettingsRepository } from "../billing/billing-settings.repository.js";
import { createRateSchema, updateRateSchema } from "../pricing/pricing.schemas.js";
import type { PricingRateDocument } from "../pricing/pricing.schemas.js";
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
};

export default adminRoutes;
