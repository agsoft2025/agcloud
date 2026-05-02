import Fastify from "fastify";
import cors from "@fastify/cors";
import authRoutes from "./routes/auth.js";
import callRoutes from "./routes/calls.js";
import healthRoutes from "./routes/health.js";
import config from "./config.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(healthRoutes);
await app.register(authRoutes, { prefix: "/api/auth" });
await app.register(callRoutes, { prefix: "/api/calls" });

app.decorate("config", config);

export default app;
