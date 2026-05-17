import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { livekitService } from "./livekit.service.js";

const tokenSchema = z.object({
  roomName: z.string().min(1).max(128),
  identity: z.string().min(1).max(128),
  name: z.string().max(128).optional(),
  ttl: z.number().int().min(60).max(86400).optional(),
});

const createRoomSchema = z.object({
  name: z.string().min(1).max(128),
  emptyTimeout: z.number().int().min(0).optional(),
  maxParticipants: z.number().int().min(0).optional(),
});

// Registered at prefix /api/livekit
export default async function livekitApiRoutes(app: FastifyInstance) {
  // POST /api/livekit/token — issue a JWT for a participant to join a room
  app.post("/token", async (request, reply) => {
    const result = tokenSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        error: "validation_error",
        details: result.error.flatten().fieldErrors,
      });
    }
    const response = await livekitService.createToken(result.data);
    return reply.status(200).send(response);
  });

  // POST /api/livekit/rooms — create a LiveKit room (called during call initiation)
  app.post("/rooms", async (request, reply) => {
    const result = createRoomSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "validation_error" });
    }
    const room = await livekitService.createRoom(result.data);
    return reply.status(201).send(room);
  });

  // GET /api/livekit/rooms — list active rooms (useful for debugging)
  app.get("/rooms", async (_request, reply) => {
    const rooms = await livekitService.listRooms();
    return reply.status(200).send(rooms);
  });
}

// Registered at prefix /api/webhooks
export async function livekitWebhookRoutes(app: FastifyInstance) {
  // POST /api/webhooks/livekit — receive events from LiveKit server
  // Requires raw body for HMAC signature verification (@fastify/rawbody must be registered)
  app.post("/livekit", { config: { rawBody: true } }, async (request, reply) => {
    const authHeader = request.headers["authorization"];
    if (!authHeader) {
      return reply.status(401).send({ error: "missing_authorization" });
    }

    const rawBody = (request as any).rawBody as string;

    let event;
    try {
      event = livekitService.verifyWebhook(rawBody, authHeader);
    } catch (err) {
      app.log.warn({ err }, "LiveKit webhook signature verification failed");
      return reply.status(401).send({ error: "invalid_signature" });
    }

    app.log.info(
      { event: event.event, room: event.room?.name },
      "LiveKit webhook received"
    );

    switch (event.event) {
      case "room_started":
        // TODO: update call state to "connecting"
        break;
      case "room_finished":
        // TODO: mark call "ended", calculate duration, persist CDR to MongoDB
        break;
      case "participant_joined":
        // TODO: update call state to "active" when both participants joined
        break;
      case "participant_left":
        // TODO: check if room empty, trigger cleanup if needed
        break;
      default:
        break;
    }

    return reply.status(200).send();
  });
}
