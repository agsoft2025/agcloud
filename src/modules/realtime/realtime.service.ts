// Realtime Service
// Owns the Socket.IO server lifecycle and wires it to the presence system.
//
// Presence responsibilities:
//   handleConnection  -- on socket connect
//   handleHeartbeat   -- on client PING (lastHeartbeat only, never lastActivity)
//   handleDisconnect  -- on socket disconnect (30-second grace period)
//
// All state-transition logic lives in presence.service.ts.

import type { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";
import config from "../../config/index.js";
import type { UserPayload } from "../../shared/middleware/auth.middleware.js";
import { UserRepository } from "../user/user.repository.js";
import { CallRepository } from "../call/call.repository.js";
import {
  handleConnection,
  handleDisconnect,
  handleHeartbeat,
  setSocketIOServer,
} from "../presence/presence.service.js";
import { socketCorsOriginCallback } from "../../shared/security/cors.js";
import { getRedisClient } from "../../shared/db/redis.client.js";
import logger from "../../shared/observability/logger.js";

let io: SocketIOServer | null = null;

const userRepo = new UserRepository();
const callRepo = new CallRepository();

// Per-IP connection cap: guards against a single client (or small botnet)
// exhausting server resources by opening unbounded socket connections.
// Redis-backed so the limit holds across horizontally-scaled instances.
const CONNECT_LIMIT_PER_WINDOW = 30;
const CONNECT_LIMIT_WINDOW_SECONDS = 60;

// Per-socket PING throttle: the client is expected to heartbeat every 30s;
// anything faster than this is either a bug or abuse and is silently dropped
// rather than hammering Redis/presence on every call.
const MIN_PING_INTERVAL_MS = 5_000;

function getClientIp(handshake: { headers: Record<string, unknown>; address: string }): string {
  const forwarded = handshake.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return handshake.address;
}

async function isConnectRateLimited(ip: string): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const key = `ratelimit:socket:connect:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, CONNECT_LIMIT_WINDOW_SECONDS);
    }
    return count > CONNECT_LIMIT_PER_WINDOW;
  } catch (err) {
    // Fail open — a Redis outage shouldn't take down realtime connectivity.
    logger.warn({ err, ip }, "Socket connect rate-limit check failed — failing open");
    return false;
  }
}

/**
 * Parse a raw Cookie header string into a key->value map.
 * Avoids a runtime dependency on the `cookie` package.
 */
function parseCookies(header: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    try {
      map[key] = decodeURIComponent(val);
    } catch {
      map[key] = val;
    }
  }
  return map;
}

export function initRealtime(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: socketCorsOriginCallback,
      credentials: true,
    },
  });

  // Wire presence broadcaster to this Socket.IO instance so it can emit
  // to local clients after receiving cross-instance broadcasts from Redis pub/sub.
  setSocketIOServer(io);

  // Per-IP connection rate limit — runs before auth so an abusive client
  // can't burn handshake attempts even with an invalid/absent token.
  io.use((socket, next) => {
    const ip = getClientIp(socket.handshake);
    isConnectRateLimited(ip).then((limited) => {
      if (limited) {
        logger.warn({ ip }, "Socket connection rejected — rate limit exceeded");
        return next(new Error("Too many connection attempts — try again shortly"));
      }
      next();
    });
  });

  // Auth middleware
  // Priority: explicit auth.token > Authorization header > HttpOnly cookie
  // The frontend sends the JWT as an HttpOnly cookie (withCredentials: true),
  // so cookie parsing is the primary path.
  io.use((socket, next) => {
    try {
      const cookieHeader  = socket.handshake.headers.cookie ?? "";
      const cookies       = parseCookies(cookieHeader);

      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, "") ??
        cookies["token"];

      if (!token) {
        console.warn("[realtime] socket rejected: no token in auth/header/cookie");
        return next(new Error("Authentication required"));
      }

      const decoded = jwt.verify(token, config.jwtSecret) as UserPayload;
      socket.data.userId = decoded.userId;
      next();
    } catch (err) {
      console.warn("[realtime] socket auth failed:", (err as Error).message);
      next(new Error("Invalid or expired token"));
    }
  });

  // Connection handler
  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;

    // Join per-user room so emitToUser() works without a local socket Map.
    void socket.join("user:" + userId);

    // Register with presence: updates Redis, broadcasts USER_ONLINE if status changed.
    void handleConnection(userId, socket.id);

    // Re-deliver calls that arrived while the user was disconnected.
    void reinvitePendingCalls(userId);

    // PING/PONG heartbeat -- client sends PING every 30s.
    // Server updates ONLY lastHeartbeat, never lastActivity.
    // Throttled defensively: a misbehaving/abusive client spamming PING
    // faster than the expected interval gets silently dropped instead of
    // hammering Redis on every event.
    let lastPingAt = 0;
    socket.on("PING", () => {
      const now = Date.now();
      if (now - lastPingAt < MIN_PING_INTERVAL_MS) return;
      lastPingAt = now;

      void handleHeartbeat(userId);
      socket.emit("PONG", { timestamp: new Date().toISOString() });
    });

    // Disconnect: removes socket from Redis set; starts 30s grace period if last socket.
    // Does NOT immediately mark OFFLINE.
    socket.on("disconnect", () => {
      void handleDisconnect(userId, socket.id);
    });
  });

  return io;
}

async function reinvitePendingCalls(userId: string): Promise<void> {
  try {
    const pendingCalls = await callRepo.getActivePendingCallsForUser(userId);
    for (const call of pendingCalls) {
      const callId = call._id.toString();
      const caller = await userRepo.getUserById(call.callerId);
      emitToUser(userId, "call:incoming", {
        callId,
        callerId: call.callerId,
        callerName: caller?.displayName ?? caller?.email ?? "Unknown",
        callerAvatar: caller?.avatarUrl ?? null,
        callType: call.callType,
        callMode: call.callMode,
        roomId: call.roomId ?? callId,
        reinvite: true,
      });
    }
  } catch (err) {
    console.error("[realtime] failed to re-notify pending calls for", userId, err);
  }
}

export function getIO(): SocketIOServer | null {
  return io;
}

// Emit an event to all active sockets belonging to a user via Socket.IO rooms.
export function emitToUser(userId: string, event: string, payload: unknown): void {
  if (!io) return;
  io.to("user:" + userId).emit(event, payload);
}

// @deprecated Presence is now tracked in Redis. Use getPresenceForUser() instead.
export function isUserOnline(_userId: string): boolean {
  return false;
}
