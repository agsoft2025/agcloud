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

let io: SocketIOServer | null = null;

const userRepo = new UserRepository();
const callRepo = new CallRepository();

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
      origin: config.env === "production" ? config.frontendUrl : true,
      credentials: true,
    },
  });

  // Wire presence broadcaster to this Socket.IO instance so it can emit
  // to local clients after receiving cross-instance broadcasts from Redis pub/sub.
  setSocketIOServer(io);

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
    socket.on("PING", () => {
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
