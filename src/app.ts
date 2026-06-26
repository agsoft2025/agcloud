import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import authRoutes from "./modules/auth/auth.routes.js";
import callRoutes from "./modules/call/call.routes.js";
import healthRoutes from "./modules/health/health.routes.js";
import livekitRoutes from "./modules/livekit/livekit.routes.js";
import userRoutes from "./modules/user/user.routes.js";
import { activityMiddleware } from "./shared/middleware/activity.middleware.js";
import config from "./config/index.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  // Register Plugins
  await app.register(cors, {
    origin: config.env === "production" ? config.frontendUrl : true,
    credentials: true
  });
  await app.register(cookie, {
    secret: config.jwtSecret,
    parseOptions: {}
  });

  // Global activity hook: fires after every response.
  // activityMiddleware is a no-op when request.user is not set (unauthenticated routes).
  // This ensures every authenticated REST call updates presence without touching individual route handlers.
  app.addHook("onResponse", activityMiddleware);

  // Register Routes
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(callRoutes, { prefix: "/calls" });
  await app.register(userRoutes, { prefix: "/users" });
  await app.register(livekitRoutes, { prefix: "/livekit" });

  app.decorate("config", config);

  return app;
}
