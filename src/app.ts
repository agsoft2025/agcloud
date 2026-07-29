import Fastify, { FastifyBaseLogger } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rawBody from "fastify-raw-body";
import authRoutes from "./modules/auth/auth.routes.js";
import callRoutes from "./modules/call/call.routes.js";
import healthRoutes, { healthCheckRoutes } from "./modules/health/health.routes.js";
import livekitRoutes from "./modules/livekit/livekit.routes.js";
import userRoutes from "./modules/user/user.routes.js";
import notificationRoutes from "./modules/notification/notification.routes.js";
import adminRoutes from "./modules/admin/admin.routes.js";
import { activityMiddleware } from "./shared/middleware/activity.middleware.js";
import { registerRateLimiting } from "./shared/middleware/rate-limit.middleware.js";
import { registerRequestId } from "./shared/middleware/request-id.js";
import { registerErrorHandler } from "./shared/middleware/error-handler.js";
import {
  getMetrics,
  getMetricsContentType,
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
} from "./shared/observability/metrics.js";
import logger from "./shared/observability/logger.js";
import config from "./config/index.js";
import { fastifyCorsOriginCallback } from "./shared/security/cors.js";

function isFastifyVersionMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.includes("expected '5.x' fastify version");
}

/**
 * These three plugins are all security controls (security headers, request
 * rate limiting, and raw-body capture for LiveKit webhook HMAC verification).
 * A Fastify version mismatch must never silently disable a security control
 * in production — that would start the app "successfully" with no headers,
 * no rate limiting, and unverifiable webhooks, and nothing short of reading
 * logs would reveal it. So this only tolerates the skip-and-warn outcome
 * outside production; in production a mismatch is a hard startup failure.
 */
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

    if (config.env === "production") {
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
    // Share the app's single pino instance with Fastify (supported since
    // Fastify v3: pass an existing pino instance directly as `logger`)
    // instead of letting it spin up its own internal pino — one logging
    // pipeline, not two. Cast to the interface type (which pino.Logger
    // structurally satisfies) so Fastify's generics resolve to the default
    // FastifyBaseLogger instead of pino's concrete branded type — otherwise
    // every FastifyInstance-typed helper in this file stops type-checking.
    logger: logger as unknown as FastifyBaseLogger,
    // The rate limiter and audit logger both need the real client IP, not the
    // reverse proxy's. This app already assumes an `x-forwarded-for`-aware
    // proxy in front of it (see rate-limit.middleware.ts's keyGenerator), so
    // trusting that header here is consistent with the existing deployment
    // assumption rather than a new one.
    trustProxy: true,
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

  // HTTP request metrics — route pattern (not raw URL) keeps label cardinality bounded.
  app.addHook("onRequest", async () => {
    httpRequestsInFlight.inc();
  });
  app.addHook("onResponse", async (request, reply) => {
    const labels = {
      method: request.method,
      route: request.routeOptions.url || "unmatched",
      status_code: String(reply.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
    httpRequestsInFlight.dec();
  });

  // Prometheus metrics
  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", getMetricsContentType());
    return reply.send(await getMetrics());
  });

  // Application routes
  await app.register(healthRoutes);
  await app.register(healthCheckRoutes, { prefix: "/health" });
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(callRoutes, { prefix: "/calls" });
  await app.register(userRoutes, { prefix: "/users" });
  await app.register(livekitRoutes, { prefix: "/livekit" });
  await app.register(notificationRoutes, { prefix: "/devices" });
  await app.register(adminRoutes, { prefix: "/admin" });

  // Error handler (must be registered last)
  registerErrorHandler(app);

  app.decorate("config", config);

  logger.info({ env: config.env }, "App built");

  return app;
}
