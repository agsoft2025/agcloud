import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import authRoutes from "./modules/auth/auth.routes.js";
import callRoutes from "./modules/call/call.routes.js";
import healthRoutes from "./modules/health/health.routes.js";
import livekitRoutes from "./modules/livekit/livekit.routes.js";
import config from "./config/index.js";

export async function buildApp() {
	const app = Fastify({ logger: true });


	// Register Plugins
	await app.register(cors, { 
		origin: config.env === "production" ? config.frontendUrl : true,
		credentials: true
	});
	await app.register(cookie, {
		secret: config.jwtSecret, // Using jwtSecret to sign cookies
		parseOptions: {} 
	});

	// Register Routes
	await app.register(healthRoutes);
	await app.register(authRoutes, { prefix: "/auth" });
	await app.register(callRoutes, { prefix: "/calls" });
	await app.register(livekitRoutes, { prefix: "/livekit" });

	app.decorate("config", config);

	return app;
}
