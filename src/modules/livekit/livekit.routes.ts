import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { WebhookReceiver } from "livekit-server-sdk";
import { CallRepository } from "../call/call.repository.js";
import { endLiveKitRoom } from "./livekit.service.js";
import { emitToUser } from "../realtime/realtime.service.js";
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

      // room_finished: mark call as ended
      if (event.event === "room_finished") {
        const roomName = event.room?.name;
        if (roomName) {
          const call = await callRepo.getCallById(roomName);
          if (call && (call.status === "active" || call.status === "initiated")) {
            await callRepo.updateCallStatus(roomName, "ended");
            await callRepo.markPendingParticipantsAsMissed(roomName);
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
