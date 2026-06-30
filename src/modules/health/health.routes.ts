import { FastifyInstance, FastifyPluginAsync } from "fastify";
import config from "../../config/index.js";
import { connectMongo } from "../../shared/db/mongo.client.js";
import { getRedisClient } from "../../shared/db/redis.client.js";
import { checkLiveKitHealth } from "../livekit/livekit.service.js";
import logger from "../../shared/observability/logger.js";

const healthRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Production-grade Dashboard at the Root
  app.get("/", async (request, reply) => {
    let mongoStatus = "offline";
    let redisStatus = "offline";
    let livekitStatus = "offline";

    try {
      const db = await connectMongo();
      const ping = await db.command({ ping: 1 });
      if (ping.ok) mongoStatus = "online";
    } catch (e) { }

    try {
      const redis = getRedisClient();
      const ping = await redis.ping();
      if (ping === "PONG") redisStatus = "online";
    } catch (e) { }

    try {
      const isLiveKitUp = await checkLiveKitHealth();
      if (isLiveKitUp) livekitStatus = "online";
    } catch (e) { }

    const isAllUp = mongoStatus === "online" && redisStatus === "online" && livekitStatus === "online";

    reply.type("text/html").send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>agcloud Backend Service</title>
          <style>
              :root {
                  --primary: #2563eb;
                  --primary-hover: #1d4ed8;
                  --bg-base: #0f172a;
                  --bg-card: #1e293b;
                  --text-main: #f8fafc;
                  --text-muted: #94a3b8;
                  --success: #10b981;
                  --error: #ef4444;
                  --border: #334155;
              }
              body {
                  font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                  background-color: var(--bg-base);
                  color: var(--text-main);
                  margin: 0;
                  padding: 2rem;
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  min-height: 100vh;
                  box-sizing: border-box;
              }
              .dashboard {
                  background: var(--bg-card);
                  border: 1px solid var(--border);
                  border-radius: 16px;
                  padding: 3rem;
                  max-width: 600px;
                  width: 100%;
                  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
              }
              .header {
                  display: flex;
                  align-items: center;
                  gap: 1rem;
                  margin-bottom: 2rem;
                  border-bottom: 1px solid var(--border);
                  padding-bottom: 1.5rem;
              }
              .status-dot {
                  width: 16px;
                  height: 16px;
                  background-color: ${isAllUp ? 'var(--success)' : 'var(--error)'};
                  border-radius: 50%;
                  box-shadow: 0 0 12px ${isAllUp ? 'var(--success)' : 'var(--error)'};
                  animation: pulse 2s infinite;
              }
              h1 {
                  margin: 0;
                  font-size: 1.75rem;
                  font-weight: 600;
                  letter-spacing: -0.025em;
              }
              @keyframes pulse {
                  0% { box-shadow: 0 0 0 0 ${isAllUp ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)'}; }
                  70% { box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); }
                  100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
              }
              .info-grid {
                  display: grid;
                  grid-template-columns: 1fr 1fr;
                  gap: 1.5rem;
              }
              .info-item {
                  background: rgba(15, 23, 42, 0.5);
                  padding: 1rem;
                  border-radius: 8px;
                  border: 1px solid var(--border);
              }
              .info-label {
                  font-size: 0.875rem;
                  color: var(--text-muted);
                  text-transform: uppercase;
                  letter-spacing: 0.05em;
                  margin-bottom: 0.5rem;
              }
              .info-value {
                  font-size: 1.125rem;
                  font-weight: 500;
                  font-family: monospace;
              }
              .status-badge {
                font-size: 0.75rem;
                padding: 2px 8px;
                border-radius: 99px;
                font-weight: 600;
                text-transform: uppercase;
              }
              .status-online { background: rgba(16, 185, 129, 0.2); color: var(--success); }
              .status-offline { background: rgba(239, 68, 68, 0.2); color: var(--error); }
              .footer {
                  margin-top: 2.5rem;
                  text-align: center;
                  color: var(--text-muted);
                  font-size: 0.875rem;
              }
          </style>
      </head>
      <body>
          <div class="dashboard">
              <div class="header">
                  <div class="status-dot"></div>
                  <h1>agcloud API is ${isAllUp ? 'Online' : 'Degraded'}</h1>
              </div>
              <p style="color: var(--text-muted); margin-bottom: 2rem; line-height: 1.6;">
                  The backend service is running. Readiness check: <b>${isAllUp ? 'PASSED' : 'FAILED'}</b>.
              </p>
              <div class="info-grid">
                  <div class="info-item">
                      <div class="info-label">MongoDB</div>
                      <div class="info-value">
                        <span class="status-badge status-${mongoStatus}">${mongoStatus}</span>
                      </div>
                  </div>
                  <div class="info-item">
                      <div class="info-label">Redis</div>
                      <div class="info-value">
                        <span class="status-badge status-${redisStatus}">${redisStatus}</span>
                      </div>
                  </div>
                  <div class="info-item">
                      <div class="info-label">LiveKit</div>
                      <div class="info-value">
                        <span class="status-badge status-${livekitStatus}">${livekitStatus}</span>
                      </div>
                  </div>
                  <div class="info-item">
                      <div class="info-label">Environment</div>
                      <div class="info-value">${config.env}</div>
                  </div>
              </div>
              <div class="footer">
                  &copy; ${new Date().getFullYear()} agSoft &bull; Protected & Monitored
              </div>
          </div>
      </body>
      </html>
    `);
  });

  // Health check API routes
  app.get("/live", async () => ({ status: "ok", type: "liveness" }));

  app.get("/ready", async (request, reply) => {
    const health = {
      mongodb: false,
      redis: false,
      livekit: false
    };

    try {
      const db = await connectMongo();
      const ping = await db.command({ ping: 1 });
      health.mongodb = !!ping.ok;
    } catch (e) {
      logger.error("MongoDB health check failed");
    }

    try {
      const redis = getRedisClient();
      const ping = await redis.ping();
      health.redis = ping === "PONG";
    } catch (e) {
      logger.error("Redis health check failed");
    }

    try {
      health.livekit = await checkLiveKitHealth();
    } catch (e) {
      logger.error("LiveKit health check failed");
    }

    const isReady = Object.values(health).every(v => v === true);

    if (!isReady) {
      return reply.status(503).send({
        status: "unhealthy",
        type: "readiness",
        details: health
      });
    }

    return {
      status: "ok",
      type: "readiness",
      details: health
    };
  });
};

export default healthRoutes;
