import type { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";
import config from "../../config/index.js";
import { UserPayload } from "../../shared/middleware/auth.middleware.js";
import { UserRepository } from "../user/user.repository.js";

let io: SocketIOServer | null = null;

const userSockets = new Map<string, Set<string>>();
const userRepo = new UserRepository();

export function initRealtime(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.env === "production" ? config.frontendUrl : true,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    try {
      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        (socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, ""));

      if (!token) {
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

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;

    const wasOffline = !userSockets.has(userId) || userSockets.get(userId)!.size === 0;
    if (!userSockets.has(userId)) {
      userSockets.set(userId, new Set());
    }
    userSockets.get(userId)!.add(socket.id);
    console.log(`[realtime] user ${userId} connected (socket ${socket.id}), total sockets: ${userSockets.get(userId)!.size}`);

    if (wasOffline) {
      void userRepo.setPresence(userId, "online");
      io!.emit("presence:update", { userId, status: "online" });
    }

    socket.on("disconnect", () => {
      const sockets = userSockets.get(userId);
      sockets?.delete(socket.id);
      console.log(`[realtime] user ${userId} disconnected (socket ${socket.id})`);

      if (sockets && sockets.size === 0) {
        userSockets.delete(userId);
        const lastSeen = new Date();
        void userRepo.setPresence(userId, "offline");
        io!.emit("presence:update", { userId, status: "offline", lastSeen: lastSeen.toISOString() });
      }
    });
  });

  return io;
}

export function getIO(): SocketIOServer | null {
  return io;
}

export function emitToUser(userId: string, event: string, payload: unknown): void {
  const socketIds = userSockets.get(userId);
  if (!socketIds || socketIds.size === 0 || !io) {
    console.log(`[realtime] emit "${event}" to ${userId} skipped: user has no active socket`);
    return;
  }

  console.log(`[realtime] emit "${event}" to ${userId} (${socketIds.size} socket(s))`);
  for (const socketId of socketIds) {
    io.to(socketId).emit(event, payload);
  }
}

export function isUserOnline(userId: string): boolean {
  return (userSockets.get(userId)?.size ?? 0) > 0;
}
