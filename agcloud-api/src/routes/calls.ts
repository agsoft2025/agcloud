import { z } from "zod";

const initCallSchema = z.object({
  calleeId: z.string().uuid(),
  callType: z.enum(["audio", "video"]).default("video")
});

export default async function callRoutes(app) {
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
}
