import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { WebhookReceiver } from "livekit-server-sdk";
import { CallRepository } from "../call/call.repository.js";
import { endLiveKitRoom } from "./livekit.service.js";
import { emitToUser } from "../realtime/realtime.service.js";
import { isFirstDeliveryOfEvent } from "../../shared/utils/idempotency.js";
import config from "../../config/index.js";
import logger from "../../shared/observability/logger.js";

const receiver = new WebhookReceiver(config.livekitApiKey, config.livekitApiSecret);
const callRepo = new CallRepository();

const livekitRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  /**
   * POST /livekit/webhook
   *
   * Uses the RAW request body for HMAC signature verification.
   * fastify-raw-body must be registered before this plugin (done in app.ts).
   * Opt-in via config: { rawBody: true }
   */
  app.post(
    "/webhook",
    { config: { rawBody: true } },
    async (request, reply) => {
      const authHeader = request.headers.authorization;

      if (!authHeader && config.env === "production") {
        logger.warn("LiveKit webhook missing Authorization header — rejected");
        return reply.status(401).send({ message: "Missing Authorization header" });
      }

      const rawBody: string | undefined = (request as any).rawBody;
      if (!rawBody) {
        return reply.status(400).send({ message: "Empty body" });
      }

      let event: any;
      try {
        if (authHeader) {
          // Verify HMAC using raw body string (not JSON-parsed)
          event = await receiver.receive(rawBody, authHeader);
        } else {
          // Dev-only fallback without signature verification
          event = JSON.parse(rawBody);
          logger.debug("LiveKit webhook: no auth header — dev bypass");
        }
      } catch (err) {
        logger.warn({ err }, "LiveKit webhook signature verification failed");
        return reply.status(400).send({ message: "Invalid webhook signature" });
      }

      if (!event) {
        return reply.status(400).send({ message: "Empty event" });
      }

      logger.info({ eventType: event.event }, "LiveKit webhook received");

      // Spec §6.2: webhook providers redeliver on timeout/5xx — dedup by the
      // event's own id so a redelivery can't double-process (e.g. two
      // `call:ended` emits racing a concurrent redelivery before the first
      // one's DB write lands).
      if (event.id) {
        const isFirstDelivery = await isFirstDeliveryOfEvent(event.id);
        if (!isFirstDelivery) {
          logger.debug({ eventId: event.id, eventType: event.event }, "Duplicate LiveKit webhook delivery — skipped");
          return reply.send({ received: true, duplicate: true });
        }
      }

      // room_started: spec §2.4 just calls for logging it — the call record
      // itself is already created synchronously in POST /calls/initiate, so
      // there's no state to update here.
      if (event.event === "room_started") {
        logger.info({ roomName: event.room?.name }, "LiveKit room started");
      }

      // track_published / track_unpublished: relay as a lightweight realtime
      // signal so clients can show mute/camera-off indicators for other
      // participants (spec §2.4: "for audio-only/video toggles"). Not
      // persisted — this is live UI state, not call history.
      if (event.event === "track_published" || event.event === "track_unpublished") {
        const roomName = event.room?.name;
        const participantId = event.participant?.identity;
        const trackType = event.track?.type; // 0=AUDIO, 1=VIDEO, 2=DATA
        if (roomName && participantId && trackType !== undefined && trackType !== 2) {
          const call = await callRepo.getCallById(roomName);
          if (call) {
            const eventName =
              event.event === "track_published" ? "call:track-published" : "call:track-unpublished";
            const payload = {
              callId: roomName,
              participantId,
              trackType: trackType === 0 ? "audio" : "video",
            };
            const allIds = new Set([call.callerId, ...call.receiverIds]);
            for (const id of allIds) {
              if (id !== participantId) emitToUser(id, eventName, payload);
            }
          }
        }
      }

      // room_finished: mark call as ended
      if (event.event === "room_finished") {
        const roomName = event.room?.name;
        if (roomName) {
          const call = await callRepo.getCallById(roomName);
          if (call && (call.status === "active" || call.status === "initiated")) {
            await callRepo.updateCallStatus(roomName, "ended");
            await callRepo.markPendingParticipantsAs(roomName, "missed");
            logger.info({ callId: roomName }, "Call auto-ended via room_finished webhook");
            const allIds = new Set([call.callerId, ...call.receiverIds]);
            for (const id of allIds) {
              emitToUser(id, "call:ended", { callId: roomName });
            }
          }
        }
      }

      // participant_joined: transition call to active when first non-caller joins
      if (event.event === "participant_joined") {
        const roomName = event.room?.name;
        const participantId = event.participant?.identity;
        if (roomName && participantId) {
          const call = await callRepo.getCallById(roomName);
          if (call && call.status === "initiated" && participantId !== call.callerId) {
            await callRepo.updateCallStatus(roomName, "active");
            logger.info({ callId: roomName, participantId }, "Call -> active via participant_joined");
          }
        }
      }

      // participant_left: end one-to-one call when a participant leaves
      if (event.event === "participant_left") {
        const roomName = event.room?.name;
        if (roomName) {
          const call = await callRepo.getCallById(roomName);
          const isOneToOne = call?.callMode === "one-to-one";
          const isActive = call?.status === "active" || call?.status === "initiated";
          if (call && isOneToOne && isActive) {
            await callRepo.updateCallStatus(roomName, "ended");
            await endLiveKitRoom(call.roomId || roomName);
            logger.info({ callId: roomName }, "One-to-one call ended via participant_left");
            const allIds = new Set([call.callerId, ...call.receiverIds]);
            for (const id of allIds) {
              emitToUser(id, "call:ended", { callId: roomName });
            }
          }
        }
      }

      // egress_ended: save recording URL
      if (event.event === "egress_ended") {
        const egressId = event.egressInfo?.egressId;
        const fileResults = event.egressInfo?.fileResults ?? [];
        const recordingUrl = fileResults[0]?.location ?? null;
        if (egressId && recordingUrl) {
          const { connectMongo } = await import("../../shared/db/mongo.client.js");
          const db = await connectMongo();
          await db.collection("calls").updateOne(
            { egressId },
            { $set: { recordingUrl, recordingEndedAt: new Date(), recording: false } }
          );
          logger.info({ egressId, recordingUrl }, "Recording URL saved");
        }
      }

      return reply.send({ received: true });
    }
  );
};

export default livekitRoutes;
