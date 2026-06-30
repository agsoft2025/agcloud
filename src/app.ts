import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rawBody from "fastify-raw-body";
import authRoutes from "./modules/auth/auth.routes.js";
import callRoutes from "./modules/call/call.routes.js";
import healthRoutes from "./modules/health/health.routes.js";
import livekitRoutes from "./modules/livekit/livekit.routes.js";
import userRoutes from "./modules/user/user.routes.js";
import notificationRoutes from "./modules/notification/notification.routes.js";
import { activityMiddleware } from "./shared/middleware/activity.middleware.js";
import { registerRateLimiting } from "./shared/middleware/rate-limit.middleware.js";
import { registerRequestId } from "./shared/middleware/request-id.js";
import { registerErrorHandler } from "./shared/middleware/error-handler.js";
import { getMetrics, getMetricsContentType } from "./shared/observability/metrics.js";
import logger from "./shared/observability/logger.js";
import config from "./config/index.js";
import { fastifyCorsOriginCallback } from "./shared/security/cors.js";

function isFastifyVersionMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.includes("expected '5.x' fastify version");
}

async function registerFastify4OptionalPlugin(
  pluginName: string,
  register: () => PromiseLike<unknown>
): Promise<void> {
  try {
    await register();
  } catch (error) {
    if (!isFastifyVersionMismatch(error)) {
      throw error;
    }

    logger.warn(
      {
        plugin: pluginName,
        installedFastify: "4.x",
        requiredFastify: "5.x",
      },
      `${pluginName} skipped because it is not compatible with the installed Fastify version`
    );
  }
}

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
  });

  // Security headers
  await registerFastify4OptionalPlugin("@fastify/helmet", () =>
    app.register(helmet, {
      contentSecurityPolicy: config.env === "production",
      hsts: config.env === "production" ? { maxAge: 31536000, includeSubDomains: true } : false,
    })
  );

  // CORS
  await app.register(cors, {
    origin: fastifyCorsOriginCallback,
    credentials: true,
  });

  // Cookies
  await app.register(cookie, {
    secret: config.jwtSecret,
    parseOptions: {},
  });

  // Raw body - required for LiveKit webhook HMAC verification
  // Routes opt-in via config: { rawBody: true }
  await registerFastify4OptionalPlugin("fastify-raw-body", () =>
    app.register(rawBody, {
      field: "rawBody",
      global: false,
      encoding: "utf8",
      runFirst: true,
    })
  );

  // Rate limiting (global + per-route overrides)
  await registerFastify4OptionalPlugin("@fastify/rate-limit", () => registerRateLimiting(app));

  // Request ID propagation
  registerRequestId(app);

  // Global presence activity hook - fires after every authenticated response
  app.addHook("onResponse", activityMiddleware);

  // Prometheus metrics
  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", getMetricsContentType());
    return reply.send(await getMetrics());
  });

  // Application routes
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(callRoutes, { prefix: "/calls" });
  await app.register(userRoutes, { prefix: "/users" });
  await app.register(livekitRoutes, { prefix: "/livekit" });
  await app.register(notificationRoutes, { prefix: "/devices" });

  // Error handler (must be registered last)
  registerErrorHandler(app);

  app.decorate("config", config);

  logger.info({ env: config.env }, "App built");

  return app;
}
