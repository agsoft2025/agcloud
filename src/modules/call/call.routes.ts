import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { initCallSchema, addParticipantSchema } from "./call.schemas.js";
import {
  createLiveKitToken,
  endLiveKitRoom,
  getLiveKitPublicUrl,
  startRoomRecording,
  stopRecording,
} from "../livekit/livekit.service.js";
import { CallRepository, DuplicateActiveCallError } from "./call.repository.js";
import { CallStateMachine } from "./call.state-machine.js";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { emitToUser } from "../realtime/realtime.service.js";
import { UserRepository } from "../user/user.repository.js";
import { BlockRepository } from "../contact/block.repository.js";
import { notifyIncomingCall } from "../notification/notification.service.js";
import { scheduleCallTimeout, cancelCallTimeout } from "./call.queue.js";
import { withIdempotency } from "../../shared/utils/idempotency.js";
import {
  callsInitiated,
  callsAccepted,
  callsRejected,
  callsEnded,
} from "../../shared/observability/metrics.js";
import logger from "../../shared/observability/logger.js";
import config from "../../config/index.js";
import { scheduleBillingTimers, cancelBillingTimers, getBillingTimerOptions } from "../billing/billing.timers.js";
import { BillingSettingsRepository } from "../billing/billing-settings.repository.js";
import { UserFreeCallRepository } from "../billing/user-free-call.repository.js";
import { calculateAndSaveCharge } from "../billing/billing.service.js";
import { UserSubscriptionRepository } from "../subscription/user-subscription.repository.js";

// Spec §5.4: 10 req/min per user (not per IP — callers behind a shared IP
// must not share this budget). `hook: "preHandler"` runs this after the
// `authenticate` preHandler in the array below, so `request.user` is
// already populated by the time the keyGenerator reads it (the default
// `onRequest` hook fires too early, before auth).
const initiateRateLimitConfig = {
  rateLimit: {
    max: 10,
    timeWindow: "1 minute",
    hook: "preHandler" as const,
    keyGenerator: (request: FastifyRequest) => request.user?.userId ?? request.ip,
  },
};

const callRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const callRepo            = new CallRepository();
  const userRepo            = new UserRepository();
  const blockRepo           = new BlockRepository();
  const billingSettingsRepo = new BillingSettingsRepository();
  const freeCallRepo        = new UserFreeCallRepository();
  const subRepo             = new UserSubscriptionRepository();

  // List endpoint for testing in postman
  app.get("/", async () => {
    return {
      endpoints: [
        "POST /calls/initiate - Initiate a new call",
        "POST /calls/:id/accept - Accept an incoming call",
        "POST /calls/:id/reject - Reject an incoming call",
        "POST /calls/:id/cancel - Cancel a call before pickup",
        "POST /calls/:id/leave - Leave an ongoing conference",
        "POST /calls/:id/end - Hang up / end a call",
        "POST /calls/:id/record/start - Start call recording",
        "POST /calls/:id/record/stop - Stop call recording",
      ],
      message: "Call routes are active",
    };
  });

  // Recent call history for the authenticated user
  app.get("/history", { preHandler: authenticate }, async (request, reply) => {
    const userId = request.user!.userId;
    const query = request.query as { limit?: string };
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? "20", 10) || 20));

    const calls = await callRepo.getCallHistoryForUser(userId, limit);

    return reply.send({
      calls: calls.map((call) => {
        let durationSeconds: number | undefined;
        if (call.startedAt && call.endedAt) {
          durationSeconds = Math.max(
            0,
            Math.round((call.endedAt.getTime() - call.startedAt.getTime()) / 1000)
          );
        }

        const joinedCount = Object.values(call.participants ?? {}).filter(
          (p) => p.status === "joined"
        ).length;
        const participantCount =
          call.status === "active" || call.status === "initiated" ? joinedCount + 1 : joinedCount;

        return {
          id: call._id.toString(),
          callerId: call.callerId,
          calleeId: call.calleeId,
          receiverIds: call.receiverIds,
          callType: call.callType,
          callMode: call.callMode,
          status: call.status,
          // The current user's own invitation status for this call (undefined for the caller)
          participantStatus: call.participants?.[userId]?.status,
          isActive: call.status === "active",
          participantCount,
          durationSeconds,
          createdAt: call.createdAt?.toISOString(),
          startedAt: call.startedAt?.toISOString(),
          endedAt: call.endedAt?.toISOString(),
        };
      }),
    });
  });

  // GET /calls/eligibility — tells the client whether the user can initiate a call.
  // Used by the UI to show a subscribe prompt before the user even tries to call.
  app.get("/eligibility", { preHandler: authenticate }, async (request, reply) => {
    const userId = request.user!.userId;
    const [callerSub, freeCallUsed] = await Promise.all([
      subRepo.findActiveByUserId(userId),
      freeCallRepo.hasUsedFreeCall(userId),
    ]);
    const isSubscribed =
      !!callerSub &&
      callerSub.status === "active" &&
      !!callerSub.endDate &&
      new Date(callerSub.endDate) > new Date();

    return reply.send({
      isSubscribed,
      freeCallUsed,
      // canInitiate: true unless the user is unsubscribed AND has used the free call.
      canInitiate: isSubscribed || !freeCallUsed,
    });
  });

  // Initiate a new call. Idempotency-protected: a client retry/double-tap
  // that resends the same `Idempotency-Key` header gets the original response
  // replayed instead of creating a second call record.
  app.post(
    "/initiate",
    { preHandler: authenticate, config: initiateRateLimitConfig },
    withIdempotency(async (request, reply) => {
      const body = initCallSchema.parse(request.body);
      const callerId = request.user!.userId;

      // Extract all receiver IDs (calleeId or receiverIds array)
      let receiverIds = body.receiverIds || [];
      if (receiverIds.length === 0 && body.calleeId) {
        receiverIds = [body.calleeId];
      }

      if (receiverIds.length === 0) {
        return reply.status(400).send({ message: "At least one receiver ID is required" });
      }

      if (receiverIds.includes(callerId)) {
        return reply.status(400).send({ message: "You cannot call yourself" });
      }

      // Check if the caller is already in an active call
      const activeCall = await callRepo.getActiveCallForUser(callerId);
      if (activeCall) {
        return reply.status(400).send({
          message: "You are already in an active call",
          callId: activeCall._id.toString(),
        });
      }

      // Blocklist guard: exclude any receiver who has blocked the caller, or
      // whom the caller has blocked, in either direction.
      const blockedReceiverIds = await blockRepo.filterBlockedEitherWay(callerId, receiverIds);

      // Callee-busy check: getActiveCallForUser already matches callerId, calleeId,
      // AND receiverIds, so it works for any role — just needs to be called per
      // receiver. Busy receivers are excluded from the invite instead of being
      // silently rung a second time while already on another call.
      const busyChecks = await Promise.all(
        receiverIds
          .filter((receiverId) => !blockedReceiverIds.includes(receiverId))
          .map(async (receiverId) => ({
            userId: receiverId,
            activeCall: await callRepo.getActiveCallForUser(receiverId),
          }))
      );
      const busyReceiverIds = busyChecks
        .filter((check) => check.activeCall !== null)
        .map((check) => check.userId);
      const availableReceiverIds = receiverIds.filter(
        (receiverId) =>
          !busyReceiverIds.includes(receiverId) && !blockedReceiverIds.includes(receiverId)
      );

      if (availableReceiverIds.length === 0) {
        const message =
          blockedReceiverIds.length > 0 && busyReceiverIds.length === 0
            ? body.callMode === "conference"
              ? "All invited participants are unavailable"
              : "You cannot call this person"
            : body.callMode === "conference"
              ? "All invited participants are currently on another call"
              : "The person you are calling is currently on another call";

        return reply.status(409).send({
          message,
          busyReceiverIds,
          ...(blockedReceiverIds.length > 0 ? { blockedReceiverIds } : {}),
        });
      }

      // ── Subscription / free-call eligibility ─────────────────────────────
      // Only the CALLER is checked here.  Unsubscribed users can still RECEIVE
      // calls from subscribed callers — the restriction applies only to who
      // initiates.  This runs server-side to prevent client-side bypass.
      {
        const [callerSub, callerFreeCallUsed] = await Promise.all([
          subRepo.findActiveByUserId(callerId),
          freeCallRepo.hasUsedFreeCall(callerId),
        ]);
        const callerIsSubscribed =
          !!callerSub &&
          callerSub.status === "active" &&
          !!callerSub.endDate &&
          new Date(callerSub.endDate) > new Date();

        if (!callerIsSubscribed && callerFreeCallUsed) {
          return reply.status(403).send({
            message: "Your free call limit is over. Please subscribe to continue.",
            code:    "FREE_CALL_EXHAUSTED",
          });
        }
      }

      // Create call record in MongoDB — only the available (non-busy) receivers
      // are actually invited/rung. The "already in an active call" check above
      // is a plain read, so two requests from the same caller can race past it
      // concurrently (spec §10.2 "simultaneous initiation"); the DB-level
      // unique index (mongo.client.ts) is the real backstop, and a rejection
      // here is reported the same way the early check reports it.
      let callRecord;
      try {
        callRecord = await callRepo.createCall(
          callerId,
          availableReceiverIds,
          body.callType,
          body.callMode,
          body.recording
        );
      } catch (err) {
        if (err instanceof DuplicateActiveCallError) {
          const concurrentActiveCall = await callRepo.getActiveCallForUser(callerId);
          return reply.status(400).send({
            message: "You are already in an active call",
            callId: concurrentActiveCall?._id.toString(),
          });
        }
        throw err;
      }
      const roomId = callRecord.roomId || callRecord._id.toString();

      // Generate token for the caller
      const token = await createLiveKitToken(callerId, roomId);

      // Notify all available receivers in real time so they see an incoming call popup
      const caller = await userRepo.getUserById(callerId);
      const callId = callRecord._id.toString();

      // Auto-transition to "missed" if nobody accepts within 60s
      void scheduleCallTimeout(callId);
      callsInitiated.inc();

      const incomingCallPayload = {
        callId,
        callerId,
        callerName: caller?.displayName ?? "Unknown",
        callerAvatar: caller?.avatarUrl ?? null,
        callType: callRecord.callType,
        callMode: callRecord.callMode,
        roomId,
        reinvite: false,
      };

      for (const receiverId of availableReceiverIds) {
        emitToUser(receiverId, "call:incoming", incomingCallPayload);
        notifyIncomingCall(receiverId, {
          callId,
          callerId,
          callerName: caller?.displayName ?? "Unknown",
          callerAvatar: caller?.avatarUrl,
          callType: callRecord.callType,
          roomId,
        }).catch((err: unknown) => logger.warn({ err, receiverId }, "Push notification failed"));
      }

      return reply.status(201).send({
        message: "Call initiated successfully",
        call: callRecord,
        token,
        roomName: roomId,
        url: getLiveKitPublicUrl(),
        // Included so the caller's client can show "X is busy" for anyone who
        // was silently dropped from this call instead of being rung.
        ...(busyReceiverIds.length > 0 ? { busyReceiverIds } : {}),
        ...(blockedReceiverIds.length > 0 ? { blockedReceiverIds } : {}),
      });
    })
  );

  // Add a participant to an ongoing call (converts it into a conference)
  app.post("/:id/add-participant", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;
    const body = addParticipantSchema.parse(request.body);
    const targetUserId = body.userId;

    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    const isAuthorized = callRecord.callerId === userId || callRecord.receiverIds.includes(userId);
    if (!isAuthorized) {
      return reply.status(403).send({ message: "You are not authorized to modify this call" });
    }

    if (callRecord.status !== "initiated" && callRecord.status !== "active") {
      return reply
        .status(400)
        .send({ message: `Cannot add participants to a call with status '${callRecord.status}'` });
    }

    if (targetUserId === callRecord.callerId) {
      return reply.status(400).send({ message: "User is already a participant in this call" });
    }

    const existingParticipant = callRecord.participants?.[targetUserId];
    if (existingParticipant?.status === "joined") {
      return reply.status(400).send({ message: "User is already in this call" });
    }

    // Re-invite: the user was previously invited (and missed/rejected/left) or
    // already has a pending invite that can be refreshed.
    const isReinvite = Boolean(existingParticipant);

    const targetUser = await userRepo.getUserById(targetUserId);
    if (!targetUser) {
      return reply.status(404).send({ message: "User not found" });
    }

    const updatedCall = await callRepo.inviteParticipant(id, targetUserId, userId);
    if (!updatedCall) {
      return reply.status(500).send({ message: "Unable to add participant" });
    }

    const roomId = updatedCall.roomId || id;
    const caller = await userRepo.getUserById(callRecord.callerId);

    // Notify the (re-)invited participant with an incoming call popup
    emitToUser(targetUserId, "call:incoming", {
      callId: id,
      callerId: callRecord.callerId,
      callerName: caller?.displayName ?? "Unknown",
      callerAvatar: caller?.avatarUrl ?? null,
      callType: updatedCall.callType,
      callMode: updatedCall.callMode,
      roomId,
      reinvite: isReinvite,
    });

    // Notify other existing participants that someone is (re-)joining
    const existingParticipantIds = new Set([callRecord.callerId, ...callRecord.receiverIds]);
    existingParticipantIds.delete(userId);
    existingParticipantIds.delete(targetUserId);
    for (const participantId of existingParticipantIds) {
      emitToUser(participantId, "call:participant-added", {
        callId: id,
        userId: targetUserId,
        displayName: targetUser.displayName ?? "Unknown",
        reinvite: isReinvite,
      });
    }

    return reply.send({ message: "Participant added successfully", call: updatedCall });
  });

  app.get("/:id", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    const isAuthorized =
      callRecord.callerId === userId ||
      (callRecord.callMode === "conference"
        ? callRecord.receiverIds.includes(userId)
        : callRecord.calleeId === userId);

    if (!isAuthorized) {
      return reply.status(403).send({ message: "You are not authorized to view this call" });
    }

    return reply.send({ call: callRecord });
  });

  // Accept a call
  app.post("/:id/accept", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const calleeId = request.user!.userId;
    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    // Validate authorization: callee must be in the receivers list or equal to calleeId
    const isAuthorized =
      callRecord.callMode === "conference"
        ? callRecord.receiverIds.includes(calleeId)
        : callRecord.calleeId === calleeId;

    if (!isAuthorized) {
      return reply.status(403).send({ message: "You are not authorized to accept this call" });
    }

    if (callRecord.status !== "active") {
      if (!CallStateMachine.isValidTransition(callRecord.status, "active")) {
        return reply.status(400).send({
          message: `Cannot transition call from '${callRecord.status}' to 'active'`,
        });
      }

      // Update status to active
      await callRepo.updateCallStatus(id, "active");
      callRecord.status = "active";
      void cancelCallTimeout(id);
      callsAccepted.inc();

      // ── Subscription-aware billing timers ────────────────────────────────
      // If the CALLER is subscribed, skip the timer entirely — no restriction.
      // If the CALLER is unsubscribed, apply the free-minute timer and mark
      // their free call as consumed once the call goes active.
      const callerSub = await subRepo.findActiveByUserId(callRecord.callerId);
      const callerIsSubscribed =
        !!callerSub &&
        callerSub.status === "active" &&
        !!callerSub.endDate &&
        new Date(callerSub.endDate) > new Date();

      if (!callerIsSubscribed) {
        const billingSettings = await billingSettingsRepo.getSettings();
        const billingOptions = {
          freeSeconds:        billingSettings.freeMinutes * 60,
          gracePeriodSeconds: billingSettings.gracePeriodSeconds,
        };
        const allParticipantIds = [callRecord.callerId, ...callRecord.receiverIds];
        scheduleBillingTimers(id, allParticipantIds, async () => {
          // Cutoff: force-end the call server-side after grace period
          try {
            await callRepo.updateCallStatus(id, "ended");
            await callRepo.markPendingParticipantsAs(id, "missed");
            const cutoffRecord = await callRepo.getCallById(id);
            if (cutoffRecord?.startedAt) {
              void calculateAndSaveCharge(id, {
                callerId:            callRecord.callerId,
                calleeIds:           callRecord.receiverIds,
                callType:            callRecord.callType,
                startedAt:           cutoffRecord.startedAt,
                endedAt:             new Date(),
                freeSecondsOverride: billingOptions.freeSeconds,
              });
            }
          } catch (_err) { /* logged inside calculateAndSaveCharge */ }
        }, billingOptions);

        // Mark the caller's free call as consumed.  This happens when the call
        // first becomes active — preventing another free-minute on a future call.
        void freeCallRepo.markFreeCallUsed(callRecord.callerId, id);
      }
    }

    // Mark this participant as joined (works for first-time accepts, re-invites,
    // and users joining an already-active call they previously missed/rejected/left).
    await callRepo.setParticipantStatus(id, calleeId, "joined");

    const roomId = callRecord.roomId || id;

    // Generate token for the callee
    const token = await createLiveKitToken(calleeId, roomId);

    const acceptingUser = await userRepo.getUserById(calleeId);

    // Notify the caller that the call was accepted
    emitToUser(callRecord.callerId, "call:accepted", {
      callId: id,
      calleeId,
      roomId,
    });

    // Notify everyone else that this participant joined the ongoing call
    const otherParticipantIds = new Set([callRecord.callerId, ...callRecord.receiverIds]);
    otherParticipantIds.delete(calleeId);
    for (const participantId of otherParticipantIds) {
      emitToUser(participantId, "call:participant-joined", {
        callId: id,
        userId: calleeId,
        displayName: acceptingUser?.displayName ?? "Unknown",
      });
    }

    // For one-to-one calls, stop ringing on the (single) other receiver entry
    // since the call is now active. Conference invitations are independent per
    // participant, so other pending invites are left untouched.
    if (callRecord.callMode === "one-to-one") {
      for (const otherReceiverId of callRecord.receiverIds) {
        if (otherReceiverId !== calleeId) {
          emitToUser(otherReceiverId, "call:cancelled", { callId: id });
        }
      }
    }

    return reply.send({
      message: "Call accepted successfully",
      call: callRecord,
      token,
      roomName: roomId,
      url: getLiveKitPublicUrl(),
    });
  });

  // Reject a call
  app.post("/:id/reject", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const calleeId = request.user!.userId;

    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    const isAuthorized =
      callRecord.callMode === "conference"
        ? callRecord.receiverIds.includes(calleeId)
        : callRecord.calleeId === calleeId;

    if (!isAuthorized) {
      return reply.status(403).send({ message: "You are not authorized to reject this call" });
    }

    if (callRecord.callMode === "conference") {
      // In a conference, one participant declining doesn't end the call for
      // everyone else — just record their own status so they can be
      // re-invited later, and let the caller/other participants know.
      await callRepo.setParticipantStatus(id, calleeId, "rejected");

      const otherParticipantIds = new Set([callRecord.callerId, ...callRecord.receiverIds]);
      otherParticipantIds.delete(calleeId);
      for (const participantId of otherParticipantIds) {
        emitToUser(participantId, "call:participant-rejected", {
          callId: id,
          userId: calleeId,
        });
      }

      return reply.send({ message: "Call rejected successfully" });
    }

    if (!CallStateMachine.isValidTransition(callRecord.status, "rejected")) {
      return reply.status(400).send({
        message: `Cannot transition call from '${callRecord.status}' to 'rejected'`,
      });
    }

    await callRepo.updateCallStatus(id, "rejected");
    await callRepo.setParticipantStatus(id, calleeId, "rejected");
    void cancelCallTimeout(id);
    callsRejected.inc();

    emitToUser(callRecord.callerId, "call:rejected", {
      callId: id,
      calleeId,
    });

    return reply.send({ message: "Call rejected successfully" });
  });

  // Cancel a call before pickup (caller hangs up while receivers are still
  // ringing, status still "initiated"). Distinct from /end, which handles a
  // call that is already active, and from /leave, which handles a single
  // participant exiting an ongoing conference. Clients must treat
  // "call:cancelled" differently from "call:ended" — the receivers were
  // never connected, so there is nothing to tear down on their side beyond
  // dismissing the incoming-call UI.
  app.post("/:id/cancel", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    if (callRecord.callerId !== userId) {
      return reply.status(403).send({ message: "Only the caller can cancel this call" });
    }

    if (!CallStateMachine.isValidTransition(callRecord.status, "cancelled")) {
      return reply.status(400).send({
        message: `Cannot cancel a call with status '${callRecord.status}'`,
      });
    }

    await callRepo.updateCallStatus(id, "cancelled");
    await callRepo.markPendingParticipantsAs(id, "cancelled");
    await cancelCallTimeout(id);
    cancelBillingTimers(id);
    await endLiveKitRoom(callRecord.roomId || id);

    for (const receiverId of callRecord.receiverIds) {
      emitToUser(receiverId, "call:cancelled", { callId: id });
    }

    return reply.send({ message: "Call cancelled successfully" });
  });

  // Leave a call (participant disconnects; meeting continues for remaining participants).
  // Unlike /end, this does NOT end the call for everyone — it only removes the
  // leaving participant and notifies others via "call:participant-left". The
  // LiveKit room stays alive until the last participant leaves.
  app.post("/:id/leave", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    const isAuthorized =
      callRecord.callerId === userId ||
      (callRecord.callMode === "conference"
        ? callRecord.receiverIds.includes(userId)
        : callRecord.calleeId === userId);

    if (!isAuthorized) {
      return reply.status(403).send({ message: "You are not authorized to leave this call" });
    }

    if (callRecord.status === "ended") {
      return reply.send({ message: "Call already ended" });
    }

    // Mark the leaving receiver in the participants map.
    // The callerId has no participants entry, so we only write for receivers.
    if (userId !== callRecord.callerId) {
      await callRepo.setParticipantStatus(id, userId, "left");
    }

    const roomId = callRecord.roomId || id;
    const leavingUser = await userRepo.getUserById(userId);

    // Re-fetch to get the updated participant statuses after the write above.
    const updatedCall = await callRepo.getCallById(id);
    const participants = updatedCall?.participants ?? callRecord.participants ?? {};

    // Build the list of participants who are still actively in the call.
    // - The callerId is considered "still in" unless they are the one leaving.
    // - Receivers are "still in" if their status is "joined".
    const remainingIds: string[] = [];
    if (userId !== callRecord.callerId) {
      remainingIds.push(callRecord.callerId);
    }
    for (const [pId, participant] of Object.entries(participants)) {
      if (pId !== userId && participant.status === "joined") {
        remainingIds.push(pId);
      }
    }

    if (remainingIds.length === 0) {
      // Last participant left — end the call and clean up the LiveKit room.
      await callRepo.updateCallStatus(id, "ended");
      await callRepo.markPendingParticipantsAs(id, "missed");
      cancelBillingTimers(id);
      await endLiveKitRoom(roomId);
      callsEnded.inc();
      // Calculate charges for time beyond the free period (fire-and-forget)
      const liveCall = await callRepo.getCallById(id);
      if (liveCall?.startedAt) {
        const timerOptsLeave = getBillingTimerOptions(id);
        void calculateAndSaveCharge(id, {
          callerId:            callRecord.callerId,
          calleeIds:           callRecord.receiverIds,
          callType:            callRecord.callType,
          startedAt:           liveCall.startedAt,
          endedAt:             new Date(),
          freeSecondsOverride: timerOptsLeave?.freeSeconds,
        });
      }
      logger.info({ callId: id, userId }, "Last participant left — call ended");
    } else {
      // Others remain — notify them so they can update participant lists.
      for (const remainingId of remainingIds) {
        emitToUser(remainingId, "call:participant-left", {
          callId: id,
          userId,
          displayName: leavingUser?.displayName ?? "Unknown",
        });
      }
      logger.info(
        { callId: id, userId, remaining: remainingIds.length },
        "Participant left call — meeting continues"
      );
    }

    return reply.send({ message: "Left call successfully" });
  });

  // End a call (Hang up)
  app.post("/:id/end", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    const isAuthorized =
      callRecord.callerId === userId ||
      (callRecord.callMode === "conference"
        ? callRecord.receiverIds.includes(userId)
        : callRecord.calleeId === userId);

    if (!isAuthorized) {
      return reply.status(403).send({ message: "You are not authorized to end this call" });
    }

    if (callRecord.status === "ended") {
      await endLiveKitRoom(callRecord.roomId || id);
      return reply.send({ message: "Call already ended" });
    }

    if (!CallStateMachine.isValidTransition(callRecord.status, "ended")) {
      return reply.status(400).send({
        message: `Cannot transition call from '${callRecord.status}' to 'ended'`,
      });
    }

    await callRepo.updateCallStatus(id, "ended");
    await callRepo.markPendingParticipantsAs(id, "missed");
    await cancelCallTimeout(id);
    cancelBillingTimers(id);
    await endLiveKitRoom(callRecord.roomId || id);
    callsEnded.inc();

    // Calculate charges for time beyond the free period (fire-and-forget)
    if (callRecord.startedAt) {
      const timerOpts = getBillingTimerOptions(id);
      void calculateAndSaveCharge(id, {
        callerId:            callRecord.callerId,
        calleeIds:           callRecord.receiverIds,
        callType:            callRecord.callType,
        startedAt:           callRecord.startedAt,
        endedAt:             new Date(),
        freeSecondsOverride: timerOpts?.freeSeconds,
      });
    }

    // Notify all other participants that the call has ended (this also clears
    // any pending invitations they may still be showing for this call).
    const participantIds = new Set([callRecord.callerId, ...callRecord.receiverIds]);
    participantIds.delete(userId);
    for (const participantId of participantIds) {
      emitToUser(participantId, "call:ended", { callId: id });
    }

    return reply.send({ message: "Call ended successfully" });
  });

  // Start call recording (LiveKit Egress)
  app.post("/:id/record/start", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    const isAuthorized = callRecord.callerId === userId || callRecord.receiverIds.includes(userId);
    if (!isAuthorized) {
      return reply.status(403).send({ message: "You are not authorized to record this call" });
    }

    // Start LiveKit Egress (recording)
    const roomName = callRecord.roomId || id;
    const timestamp = Date.now();
    const fileOutput = { filepath: `/recordings/room-${roomName}-${timestamp}.mp4` };
    const egress = await startRoomRecording(roomName, fileOutput);

    await callRepo.updateCallStatus(id, callRecord.status, {
      recording: true,
      recordingStartedAt: new Date(),
      egressId: egress.egressId,
    });

    return reply.send({
      message: "Call recording started successfully",
      egressId: egress.egressId,
    });
  });

  // Stop call recording (LiveKit Egress)
  app.post("/:id/record/stop", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    const isAuthorized = callRecord.callerId === userId || callRecord.receiverIds.includes(userId);
    if (!isAuthorized) {
      return reply
        .status(403)
        .send({ message: "You are not authorized to stop recording this call" });
    }

    if (!callRecord.egressId) {
      return reply.status(400).send({ message: "No active recording (egressId missing)" });
    }

    await stopRecording(callRecord.egressId);
    await callRepo.updateCallStatus(id, callRecord.status, {
      recording: false,
      recordingEndedAt: new Date(),
    });

    return reply.send({ message: "Call recording stopped successfully" });
  });

  // HTML WebRTC Tester Page — unauthenticated by design (it's a manual
  // connectivity smoke-test tool, not an app feature), so it must never be
  // reachable in production: it pulls a third-party CDN script and exposes
  // the configured LiveKit host URL to anyone who finds the path.
  app.get("/test", async (request, reply) => {
    if (config.env === "production") {
      return reply.status(404).send({ message: "Not found" });
    }

    reply.type("text/html");
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LiveKit WebRTC Call Tester</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js"></script>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(255, 255, 255, 0.03);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --primary-glow: rgba(79, 70, 229, 0.4);
      --success: #10b981;
      --danger: #ef4444;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Outfit', sans-serif;
    }

    body {
      background-color: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem 1rem;
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(79, 70, 229, 0.15) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(16, 185, 129, 0.1) 0%, transparent 40%);
    }

    header {
      text-align: center;
      margin-bottom: 2.5rem;
    }

    h1 {
      font-size: 2.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, #a5b4fc 0%, #818cf8 50%, #34d399 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }

    p.subtitle {
      color: var(--text-muted);
      font-size: 1.1rem;
    }

    .container {
      width: 100%;
      max-width: 1100px;
      display: grid;
      grid-template-columns: 1fr;
      gap: 2rem;
    }

    @media (min-width: 768px) {
      .container {
        grid-template-columns: 320px 1fr;
      }
    }

    .panel {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(16px);
      border-radius: 1.25rem;
      padding: 1.75rem;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    label {
      font-size: 0.85rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    input, select {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      padding: 0.85rem 1rem;
      border-radius: 0.75rem;
      color: #fff;
      font-size: 0.95rem;
      outline: none;
      transition: all 0.3s ease;
    }

    input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--primary-glow);
    }

    button {
      background: var(--primary);
      border: none;
      color: white;
      padding: 1rem;
      border-radius: 0.75rem;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }

    button:hover {
      background: var(--primary-hover);
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);
    }

    button:active {
      transform: translateY(0);
    }

    button.disconnect {
      background: var(--danger);
    }

    button.disconnect:hover {
      background: #dc2626;
      box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 0.50rem;
      font-size: 0.9rem;
      font-weight: 600;
      padding: 0.5rem 1rem;
      border-radius: 2rem;
      align-self: flex-start;
      background: rgba(255, 255, 255, 0.05);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-muted);
    }

    .status-dot.connected { background: var(--success); box-shadow: 0 0 8px var(--success); }
    .status-dot.connecting { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; }
    .status-dot.disconnected { background: var(--danger); box-shadow: 0 0 8px var(--danger); }

    .video-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 1.5rem;
      min-height: 450px;
    }

    @media (min-width: 992px) {
      .video-grid {
        grid-template-columns: 1fr 1fr;
      }
    }

    .video-box {
      background: #060913;
      border: 1px solid var(--card-border);
      border-radius: 1.25rem;
      overflow: hidden;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.8);
    }

    .video-box video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform: scaleX(-1); /* mirror local video */
    }

    /* Don't mirror remote video */
    .video-box.remote video {
      transform: scaleX(1);
    }

    .video-label {
      position: absolute;
      bottom: 1rem;
      left: 1rem;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(8px);
      padding: 0.4rem 0.8rem;
      border-radius: 0.5rem;
      font-size: 0.85rem;
      font-weight: 500;
      border: 1px solid rgba(255, 255, 255, 0.1);
      z-index: 10;
    }

    .placeholder-text {
      color: var(--text-muted);
      font-size: 1rem;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
    }

    .placeholder-text svg {
      width: 48px;
      height: 48px;
      stroke: var(--text-muted);
      opacity: 0.4;
    }
  </style>
</head>
<body>

  <header>
    <h1>WebRTC Call Tester</h1>
    <p class="subtitle">Quick-test LiveKit audio and video connectivity</p>
  </header>

  <div class="container">
    <!-- Configuration panel -->
    <div class="panel">
      <div class="status-badge">
        <div id="status-dot" class="status-dot disconnected"></div>
        <span id="status-text">Disconnected</span>
      </div>

      <div class="form-group">
        <label for="ws-url">LiveKit Host URL</label>
        <input type="text" id="ws-url" value="${config.livekitUrl}" placeholder="ws://localhost:7880">
      </div>

      <div class="form-group">
        <label for="token">LiveKit Token</label>
        <input type="text" id="token" placeholder="Paste generated JWT token here">
      </div>

      <button id="connect-btn">Connect & Start</button>
    </div>

    <!-- Video streams grid -->
    <div class="video-grid">
      <!-- Local stream -->
      <div class="video-box" id="local-video-box">
        <div class="video-label">Local Camera (You)</div>
        <div class="placeholder-text" id="local-placeholder">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Camera feed not active
        </div>
      </div>

      <!-- Remote stream -->
      <div class="video-box remote" id="remote-video-box">
        <div class="video-label">Remote Stream (Peer)</div>
        <div class="placeholder-text" id="remote-placeholder">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          No remote peer connected
        </div>
      </div>
    </div>
  </div>

  <script>
    const LiveKitClient = window.LivekitClient || window.LiveKit || window.LiveKitClient;
    let currentRoom = null;
    const connectBtn = document.getElementById('connect-btn');
    const tokenInput = document.getElementById('token');
    const wsUrlInput = document.getElementById('ws-url');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    const localVideoBox = document.getElementById('local-video-box');
    const remoteVideoBox = document.getElementById('remote-video-box');
    const localPlaceholder = document.getElementById('local-placeholder');
    const remotePlaceholder = document.getElementById('remote-placeholder');

    function updateStatus(state, text) {
      statusDot.className = 'status-dot ' + state;
      statusText.innerText = text;
    }

    async function toggleConnection() {
      if (currentRoom) {
        // Disconnect
        await currentRoom.disconnect();
        return;
      }

      const token = tokenInput.value.trim();
      const wsUrl = wsUrlInput.value.trim();

      if (!token) {
        alert('Please paste a valid LiveKit JWT Token first.');
        return;
      }

      connectBtn.disabled = true;
      connectBtn.innerText = 'Connecting...';
      updateStatus('connecting', 'Connecting...');

      try {
        const room = new LiveKitClient.Room({
          adaptiveStream: true,
          dynacast: true,
        });

        currentRoom = room;

        // Setup remote stream subscriber listeners
        room
          .on(LiveKitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === 'video') {
              remotePlaceholder.style.display = 'none';
              
              // Remove old remote video if any
              const existingVideo = remoteVideoBox.querySelector('video');
              if (existingVideo) existingVideo.remove();
              
              const el = track.attach();
              remoteVideoBox.appendChild(el);
            } else if (track.kind === 'audio') {
              const el = track.attach();
              remoteVideoBox.appendChild(el); // Attach audio to play
            }
          })
          .on(LiveKitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
            track.detach();
            if (track.kind === 'video') {
              const videoEl = remoteVideoBox.querySelector('video');
              if (videoEl) videoEl.remove();
              remotePlaceholder.style.display = 'flex';
            }
          })
          .on(LiveKitClient.RoomEvent.Disconnected, () => {
            console.log('Room disconnected');
            cleanupRoomUI();
          });

        // Connect to LiveKit Room
        await room.connect(wsUrl, token);
        
        updateStatus('connected', 'Connected');
        connectBtn.disabled = false;
        connectBtn.innerText = 'Disconnect';
        connectBtn.classList.add('disconnect');

        // Share camera and microphone
        await room.localParticipant.setCameraEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);

        // Display local stream in the local camera box
        room.localParticipant.trackPublications.forEach((publication) => {
          if (publication.track && publication.track.kind === 'video') {
            localPlaceholder.style.display = 'none';
            
            const existingVideo = localVideoBox.querySelector('video');
            if (existingVideo) existingVideo.remove();

            const el = publication.track.attach();
            localVideoBox.appendChild(el);
          }
        });

      } catch (err) {
        console.error('Failed to connect to LiveKit:', err);
        alert('Connection failed: ' + err.message);
        cleanupRoomUI();
      }
    }

    function cleanupRoomUI() {
      currentRoom = null;
      connectBtn.disabled = false;
      connectBtn.innerText = 'Connect & Start';
      connectBtn.classList.remove('disconnect');
      updateStatus('disconnected', 'Disconnected');

      // Clear local video element
      const localVideo = localVideoBox.querySelector('video');
      if (localVideo) localVideo.remove();
      localPlaceholder.style.display = 'flex';

      // Clear remote video element
      const remoteVideo = remoteVideoBox.querySelector('video');
      if (remoteVideo) remoteVideo.remove();
      remotePlaceholder.style.display = 'flex';
    }

    connectBtn.addEventListener('click', toggleConnection);
  </script>
</body>
</html>
    `;
  });
};

export default callRoutes;
