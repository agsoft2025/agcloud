import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { initCallSchema } from "./call.schemas.js";

const callRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post("/init", async (request, reply) => {
    const body = initCallSchema.parse(request.body);
    // TODO: create call record, create LiveKit room, return tokens
    return {
      message: "call init placeholder",
      calleeId: body.calleeId,
      callType: body.callType
    };
  });

  app.post("/accept", async (request, reply) => {
    const { callId } = request.body as { callId: string };
    // TODO: accept the call and update the call state
    return { message: "call accept placeholder", callId };
  });
};

export default callRoutes;
