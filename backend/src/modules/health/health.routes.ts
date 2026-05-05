import { FastifyInstance, FastifyPluginAsync } from "fastify";
import config from "../../config/index.js";

const healthRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Production-grade Dashboard at the Root
  app.get("/", async (request, reply) => {
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
                  background-color: var(--success);
                  border-radius: 50%;
                  box-shadow: 0 0 12px var(--success);
                  animation: pulse 2s infinite;
              }
              h1 {
                  margin: 0;
                  font-size: 1.75rem;
                  font-weight: 600;
                  letter-spacing: -0.025em;
              }
              @keyframes pulse {
                  0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
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
                  <h1>agcloud API is Online</h1>
              </div>
              <p style="color: var(--text-muted); margin-bottom: 2rem; line-height: 1.6;">
                  The backend service is successfully running and accepting connections.
              </p>
              <div class="info-grid">
                  <div class="info-item">
                      <div class="info-label">Environment</div>
                      <div class="info-value">Development</div>
                  </div>
                  <div class="info-item">
                      <div class="info-label">Framework</div>
                      <div class="info-value">Fastify v4</div>
                  </div>
                  <div class="info-item">
                      <div class="info-label">Port</div>
                      <div class="info-value">${config.port}</div>
                  </div>
                  <div class="info-item">
                      <div class="info-label">Node version</div>
                      <div class="info-value">${process.version}</div>
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
  app.get("/ready", async () => ({ status: "ok", type: "readiness" }));
};

export default healthRoutes;
