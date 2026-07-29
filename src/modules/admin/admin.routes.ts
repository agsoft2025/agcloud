import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { CallRepository } from "../call/call.repository.js";
import { authenticate, requireRole } from "../../shared/middleware/auth.middleware.js";
import { writeAuditLog } from "../../shared/security/audit-log.js";

const adminRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const callRepo = new CallRepository();

  // GET /admin/calls/active — every call currently ringing or in progress,
  // across all users. Admin-only: this exposes call metadata (participants,
  // room IDs) that has no per-user authorization scope, unlike every other
  // /calls/* route which checks the caller is a participant.
  app.get(
    "/calls/active",
    { preHandler: [authenticate, requireRole("admin")] },
    async (request, reply) => {
      const query = request.query as { page?: string; limit?: string };
      const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? "20", 10) || 20));

      const { calls, total } = await callRepo.getActiveCalls(page, limit);

      // Fire-and-forget, same posture as every other audit write in this
      // codebase: an admin viewing live call metadata is itself the
      // security-relevant event per spec ("Admin operations ... audit-logged"),
      // and must never block or fail the request it's observing.
      await writeAuditLog({
        event: "admin.calls_active.viewed",
        severity: "info",
        userId: request.user?.userId,
        email: request.user?.email,
        ip: request.ip ?? null,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
        metadata: { page, limit, resultCount: calls.length, total },
      });

      return reply.send({
        calls: calls.map((call) => ({
          id: call._id.toString(),
          callerId: call.callerId,
          calleeId: call.calleeId,
          receiverIds: call.receiverIds,
          callType: call.callType,
          callMode: call.callMode,
          status: call.status,
          recording: call.recording,
          roomId: call.roomId,
          createdAt: call.createdAt?.toISOString(),
          startedAt: call.startedAt?.toISOString(),
        })),
        total,
        page,
        limit,
      });
    }
  );
};

export default adminRoutes;
