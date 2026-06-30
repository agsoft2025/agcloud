/**
 * Global Activity Middleware
 *
 * Executes after every authenticated request and updates the user's
 * `lastActivity` timestamp in Redis — throttled to once every 30 seconds to
 * avoid excessive writes.
 *
 * This is the ONLY place where REST/GraphQL activity updates presence.
 * Heartbeats (WebSocket PING) update `lastHeartbeat` only, never this field.
 *
 * Usage: register as a preHandler after `authenticate` on any route, or add
 * once in app.ts via addHook('preHandler', …) for global coverage.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import logger from "../observability/logger.js";
import { handleActivity } from "../../modules/presence/presence.service.js";

export async function activityMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const userId = request.user?.userId;
  if (!userId) return;

  // Fire-and-forget: presence update must never delay the HTTP response.
  handleActivity(userId).catch((err) => {
    logger.warn({ err, userId }, "[activity-middleware] presence update failed");
  });
}
