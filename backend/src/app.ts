import Fastify from "fastify";
import cors from "@fastify/cors";
import authRoutes from "./modules/auth/auth.routes.js";
import callRoutes from "./modules/call/call.routes.js";
import healthRoutes from "./modules/health/health.routes.js";
import config from "./config/index.js";

export async function buildApp() {
	const app = Fastify({ logger: true });


	// Register Plugins
	await app.register(cors, { origin: true });

	// Register Routes
	await app.register(healthRoutes);
	await app.register(authRoutes, { prefix: "/api/auth" });
	await app.register(callRoutes, { prefix: "/api/calls" });

	app.decorate("config", config);

	return app;
}
