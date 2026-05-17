import Fastify from "fastify";
import cors from "@fastify/cors";
import rawBody from "@fastify/rawbody";
import authRoutes from "./routes/auth.js";
import callRoutes from "./routes/calls.js";
import healthRoutes from "./routes/health.js";
import livekitApiRoutes, { livekitWebhookRoutes } from "./modules/livekit/livekit.routes.js";
import config from "./config.js";

const app = Fastify({ logger: true });

// rawbody must be registered first — before any content-type parsers
// Used by the LiveKit webhook route to get raw string body for HMAC verification
await app.register(rawBody, {
  field: "rawBody",
  global: false,    // only attach rawBody where config.rawBody = true
  encoding: "utf8",
  runFirst: true,
});

await app.register(cors, { origin: true });
await app.register(healthRoutes);
await app.register(authRoutes, { prefix: "/api/auth" });
await app.register(callRoutes, { prefix: "/api/calls" });
await app.register(livekitApiRoutes, { prefix: "/api/livekit" });
await app.register(livekitWebhookRoutes, { prefix: "/api/webhooks" });

app.decorate("config", config);

export default app;
