import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import logger from "../../shared/observability/logger.js";
import { registerDevice, unregisterDevice } from "./notification.service.js";

const registerSchema = z.object({
  platform: z.enum(["android", "ios", "web"]),
  token: z.string().min(1, "Token is required"),
  voipToken: z.string().optional(), // iOS PushKit token
});

const notificationRoutes: FastifyPluginAsync = async (app) => {
  // POST /devices/register — register or refresh a push token
  app.post("/register", { preHandler: authenticate }, async (request, reply) => {
    try {
      const body = registerSchema.parse(request.body);
      await registerDevice(
        request.user!.userId,
        body.platform,
        body.token,
        body.voipToken
      );
      return reply.status(201).send({ message: "Device registered successfully" });
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ message: "Validation failed", errors: err.issues });
      }
      logger.error({ err }, "Device registration failed");
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // DELETE /devices/:token — unregister a push token (logout / token refresh)
  app.delete("/:token", { preHandler: authenticate }, async (request, reply) => {
    const { token } = request.params as { token: string };
    await unregisterDevice(request.user!.userId, token);
    return reply.send({ message: "Device unregistered" });
  });
};

export default notificationRoutes;
