import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { UserRepository } from "./user.repository.js";
import { UserDocument } from "./user.schemas.js";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { activityMiddleware } from "../../shared/middleware/activity.middleware.js";
import { getPresenceForUser, presenceRepo, computeStatus } from "../presence/presence.service.js";
import { ObjectId } from "mongodb";
import { connectMongo } from "../../shared/db/mongo.client.js";
import { z } from "zod";

/**
 * Build a contact object.
 * liveStatus comes from Redis (the source of truth).
 * If Redis has no record for a user they are OFFLINE -- the MongoDB
 * presenceStatus field is intentionally NOT used as fallback because it
 * can be stale for days after a server restart or ungraceful shutdown.
 */
function toContact(user: UserDocument, liveStatus: string | null) {
  return {
    id:              user._id.toString(),
    email:           user.email,
    displayName:     user.displayName,
    avatarUrl:       user.avatarUrl ?? null,
    role:            user.role,
    status:          user.status,
    phoneNumber:     user.phoneNumber,
    extensionNumber: user.extensionNumber,
    designation:     user.designation,
    department:      user.department,
    // null means Redis has no record => user is offline
    presenceStatus:  (liveStatus ?? "offline").toLowerCase(),
    lastSeenAt:      user.lastSeenAt,
  };
}

const updateProfileSchema = z.object({
  displayName: z
    .string()
    .min(2, "Display name must be at least 2 characters")
    .max(50, "Display name must be at most 50 characters")
    .optional(),
  avatarUrl: z.string().optional(),
});

const userRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const userRepo = new UserRepository();
  const db = await connectMongo();
  const usersCollection = db.collection<UserDocument>("users");

  // GET /users — contact list enriched with live Redis presence
  app.get("/", { preHandler: [authenticate, activityMiddleware] }, async (request, reply) => {
    const query = request.query as { page?: string; limit?: string; search?: string };
    const page  = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? "20", 10) || 20));

    const { users, total } = await userRepo.listContacts({
      page,
      limit,
      search: query.search,
      excludeUserId: request.user?.userId,
    });

    const userIds = users.map((u) => u._id.toString());
    const [presenceMap, socketCountMap] = await Promise.all([
      presenceRepo.batchGetPresence(userIds),
      presenceRepo.batchGetSocketCounts(userIds),
    ]);

    return reply.send({
      users: users.map((u) => {
        const id       = u._id.toString();
        const presence = presenceMap.get(id);
        const sockets  = socketCountMap.get(id) ?? 0;
        // No Redis record => user has never connected since last restart => OFFLINE
        const live = presence ? computeStatus(presence, sockets) : null;
        return toContact(u, live);
      }),
      total,
      page,
      limit,
    });
  });

  // GET /users/presence — bulk live presence (Redis-backed, not MongoDB)
  app.get("/presence", { preHandler: [authenticate, activityMiddleware] }, async (_request, reply) => {
    // Fetch all users from DB to get the full user list, then enrich from Redis.
    // We do NOT read presenceStatus from MongoDB here because it can be hours stale.
    const allDbPresence = await userRepo.getAllPresence();
    const userIds = allDbPresence.map((p) => p.userId);

    const [presenceMap, socketCountMap] = await Promise.all([
      presenceRepo.batchGetPresence(userIds),
      presenceRepo.batchGetSocketCounts(userIds),
    ]);

    return reply.send(
      allDbPresence.map((p) => {
        const redisPresence = presenceMap.get(p.userId);
        const sockets = socketCountMap.get(p.userId) ?? 0;
        // If Redis has no record the user is OFFLINE (no active session since last restart)
        const status = redisPresence
          ? computeStatus(redisPresence, sockets).toLowerCase()
          : "offline";
        const lastSeen = redisPresence?.lastSeen ?? p.lastSeen?.toISOString() ?? null;
        return { userId: p.userId, status, lastSeen };
      })
    );
  });

  // GET /users/:id/presence — real-time presence for a single user
  app.get("/:id/presence", { preHandler: [authenticate, activityMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    // If no Redis record exists, user is OFFLINE
    const [redisPresence, sockets] = await Promise.all([
      presenceRepo.getPresence(id),
      presenceRepo.getSocketCount(id),
    ]);

    if (!redisPresence) {
      // Fall back to DB for lastSeen even when user has no Redis record
      const dbUser = await userRepo.getUserById(id);
      if (!dbUser) return reply.status(404).send({ message: "User not found" });
      return reply.send({
        userId:        id,
        status:        "OFFLINE",
        lastSeen:      dbUser.lastSeenAt?.toISOString() ?? null,
        activeDevices: 0,
        isConnected:   false,
      });
    }

    const status = computeStatus(redisPresence, sockets);
    return reply.send({
      userId:        id,
      status,
      lastSeen:      redisPresence.lastSeen ?? null,
      activeDevices: sockets,
      isConnected:   sockets > 0,
    });
  });

  // PUT /users/me — update own profile
  app.put("/me", { preHandler: [authenticate, activityMiddleware] }, async (request, reply) => {
    try {
      const body = updateProfileSchema.parse(request.body);

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.displayName !== undefined) updates.displayName = body.displayName;
      if (body.avatarUrl !== undefined)   updates.avatarUrl   = body.avatarUrl;

      const result = await usersCollection.findOneAndUpdate(
        { _id: new ObjectId(request.user!.userId) },
        { $set: updates },
        {
          returnDocument: "after",
          projection: { passwordHash: 0, resetPasswordToken: 0, resetPasswordExpires: 0 },
        }
      );

      if (!result) return reply.status(404).send({ message: "User not found" });

      return reply.send({
        id:          result._id,
        email:       result.email,
        role:        result.role,
        status:      result.status,
        displayName: result.displayName,
        avatarUrl:   result.avatarUrl ?? null,
      });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ message: "Validation failed", errors: error.issues });
      }
      console.error(error);
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // GET /users/:id — single user profile with live presence
  app.get("/:id", { preHandler: [authenticate, activityMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await userRepo.getUserById(id);
    if (!user) return reply.status(404).send({ message: "User not found" });

    const [presence, sockets] = await Promise.all([
      presenceRepo.getPresence(id),
      presenceRepo.getSocketCount(id),
    ]);
    const live = presence ? computeStatus(presence, sockets) : null;
    return reply.send(toContact(user, live));
  });
};

export default userRoutes;
