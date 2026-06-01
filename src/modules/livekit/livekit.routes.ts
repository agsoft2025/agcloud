import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { WebhookReceiver } from "livekit-server-sdk";
import { CallRepository } from "../call/call.repository.js";
import { endLiveKitRoom } from "./livekit.service.js";
import config from "../../config/index.js";

const receiver = new WebhookReceiver(config.livekitApiKey, config.livekitApiSecret);
const callRepo = new CallRepository();

const livekitRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post("/webhook", async (request, reply) => {
    const authHeader = request.headers.authorization;
    
    let event: any;
    try {
      const bodyStr = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      
      if (authHeader) {
        event = await receiver.receive(bodyStr, authHeader);
      } else {
        event = request.body; // Fallback for local testing/dev
      }
    } catch (err) {
      console.warn("LiveKit Webhook signature verification failed:", err);
      // Fallback in development
      if (config.env !== "production") {
        event = request.body;
      } else {
        return reply.status(400).send({ message: "Invalid signature" });
      }
    }

    if (!event) {
      return reply.status(400).send({ message: "Empty body" });
    }

    console.log(`LiveKit Webhook Event Received: ${event.event}`, event);

    if (event.event === "room_finished") {
      const roomName = event.room?.name; // room.name is our callId (MongoDB ObjectId string)
      if (roomName) {
        const call = await callRepo.getCallById(roomName);
        if (call && (call.status === "active" || call.status === "initiated")) {
          await callRepo.updateCallStatus(roomName, "ended");
          console.log(`Call ${roomName} automatically ended via LiveKit Webhook (room_finished).`);
        }
      }
    }

    if (event.event === "participant_left") {
      const roomName = event.room?.name;
      if (roomName) {
        const call = await callRepo.getCallById(roomName);
        const isOneToOneCall = call?.callMode === "one-to-one";
        const isActiveCall = call?.status === "active" || call?.status === "initiated";

        if (call && isOneToOneCall && isActiveCall) {
          await callRepo.updateCallStatus(roomName, "ended");
          await endLiveKitRoom(call.roomId || roomName);
          console.log(`One-to-one call ${roomName} ended because a participant left.`);
        }
      }
    }

    return reply.send({ received: true });
  });
};

export default livekitRoutes;
