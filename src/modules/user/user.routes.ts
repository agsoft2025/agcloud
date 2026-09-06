import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { UserRepository } from "./user.repository.js";
import { UserDocument } from "./user.schemas.js";
import { authenticate, requireRole } from "../../shared/middleware/auth.middleware.js";
import { activityMiddleware } from "../../shared/middleware/activity.middleware.js";
import { presenceRepo, computeStatus } from "../presence/presence.service.js";
import { ContactRepository } from "../contact/contact.repository.js";
import { BlockRepository } from "../contact/block.repository.js";
import { ObjectId } from "mongodb";
import { connectMongo } from "../../shared/db/mongo.client.js";
import logger from "../../shared/observability/logger.js";
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
    id: user._id.toString(),
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? null,
    role: user.role,
    status: user.status,
    phoneNumber: user.phoneNumber,
    extensionNumber: user.extensionNumber,
    designation: user.designation,
    department: user.department,
    // null means Redis has no record => user is offline
    presenceStatus: (liveStatus ?? "offline").toLowerCase(),
    lastSeenAt: user.lastSeenAt,
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

// Admin-only: fields an admin may change on any user account
const adminUpdateUserSchema = z.object({
  displayName: z
    .string()
    .min(2, "Display name must be at least 2 characters")
    .max(50, "Display name must be at most 50 characters")
    .optional(),
  role: z.enum(["user", "admin", "moderator", "support"]).optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional(),
});

const userIdParamSchema = z.object({ id: z.string().min(1) });

const userRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const userRepo = new UserRepository();
  const contactRepo = new ContactRepository();
  const blockRepo = new BlockRepository();
  const db = await connectMongo();
  const usersCollection = db.collection<UserDocument>("users");

  // GET /users — contact list enriched with live Redis presence
  app.get("/", { preHandler: [authenticate, activityMiddleware] }, async (request, reply) => {
    const query = request.query as { page?: string; limit?: string; search?: string };
    const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
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
        const id = u._id.toString();
        const presence = presenceMap.get(id);
        const sockets = socketCountMap.get(id) ?? 0;
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
  app.get(
    "/presence",
    { preHandler: [authenticate, activityMiddleware] },
    async (_request, reply) => {
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
    }
  );

  // GET /users/:id/presence — real-time presence for a single user
  app.get(
    "/:id/presence",
    { preHandler: [authenticate, activityMiddleware] },
    async (request, reply) => {
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
          userId: id,
          status: "OFFLINE",
          lastSeen: dbUser.lastSeenAt?.toISOString() ?? null,
          activeDevices: 0,
          isConnected: false,
        });
      }

      const status = computeStatus(redisPresence, sockets);
      return reply.send({
        userId: id,
        status,
        lastSeen: redisPresence.lastSeen ?? null,
        activeDevices: sockets,
        isConnected: sockets > 0,
      });
    }
  );

  // PUT /users/me — update own profile
  app.put("/me", { preHandler: [authenticate, activityMiddleware] }, async (request, reply) => {
    try {
      const body = updateProfileSchema.parse(request.body);

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.displayName !== undefined) updates.displayName = body.displayName;
      if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;

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
        id: result._id,
        email: result.email,
        role: result.role,
        status: result.status,
        displayName: result.displayName,
        avatarUrl: result.avatarUrl ?? null,
      });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ message: "Validation failed", errors: error.issues });
      }
      logger.error({ err: error }, "PUT /users/me failed");
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // GET /users/me/contacts — the caller's own contact list, enriched with live presence
  app.get(
    "/me/contacts",
    { preHandler: [authenticate, activityMiddleware] },
    async (request, reply) => {
      const ownerId = request.user!.userId;
      const contactIds = await contactRepo.listContactIds(ownerId);

      const users = (await Promise.all(contactIds.map((id) => userRepo.getUserById(id)))).filter(
        (u): u is UserDocument => u !== null
      );

      const userIds = users.map((u) => u._id.toString());
      const [presenceMap, socketCountMap] = await Promise.all([
        presenceRepo.batchGetPresence(userIds),
        presenceRepo.batchGetSocketCounts(userIds),
      ]);

      return reply.send({
        contacts: users.map((u) => {
          const id = u._id.toString();
          const presence = presenceMap.get(id);
          const sockets = socketCountMap.get(id) ?? 0;
          const live = presence ? computeStatus(presence, sockets) : null;
          return toContact(u, live);
        }),
      });
    }
  );

  // POST /users/me/contacts — add a contact by user ID
  app.post(
    "/me/contacts",
    { preHandler: [authenticate, activityMiddleware] },
    async (request, reply) => {
      const ownerId = request.user!.userId;
      const body = z.object({ userId: z.string().min(1) }).parse(request.body);

      if (body.userId === ownerId) {
        return reply.status(400).send({ message: "You cannot add yourself as a contact" });
      }

      const targetUser = await userRepo.getUserById(body.userId);
      if (!targetUser) {
        return reply.status(404).send({ message: "User not found" });
      }

      await contactRepo.addContact(ownerId, body.userId);
      return reply.status(201).send({ message: "Contact added successfully" });
    }
  );

  // DELETE /users/me/contacts/:id — remove a contact
  app.delete(
    "/me/contacts/:id",
    { preHandler: [authenticate, activityMiddleware] },
    async (request, reply) => {
      const ownerId = request.user!.userId;
      const { id } = userIdParamSchema.parse(request.params);

      const removed = await contactRepo.removeContact(ownerId, id);
      if (!removed) {
        return reply.status(404).send({ message: "Contact not found" });
      }
      return reply.send({ message: "Contact removed successfully" });
    }
  );

  // GET /users/me/blocked — list of users the caller has blocked
  app.get(
    "/me/blocked",
    { preHandler: [authenticate, activityMiddleware] },
    async (request, reply) => {
      const blockerId = request.user!.userId;
      const blockedIds = await blockRepo.listBlockedIds(blockerId);

      const users = (await Promise.all(blockedIds.map((id) => userRepo.getUserById(id)))).filter(
        (u): u is UserDocument => u !== null
      );

      return reply.send({
        blocked: users.map((u) => ({
          id: u._id.toString(),
          email: u.email,
          displayName: u.displayName,
          avatarUrl: u.avatarUrl ?? null,
        })),
      });
    }
  );

  // POST /users/me/block/:id — block a user (also guards call initiation)
  app.post(
    "/me/block/:id",
    { preHandler: [authenticate, activityMiddleware] },
    async (request, reply) => {
      const blockerId = request.user!.userId;
      const { id } = userIdParamSchema.parse(request.params);

      if (id === blockerId) {
        return reply.status(400).send({ message: "You cannot block yourself" });
      }

      const targetUser = await userRepo.getUserById(id);
      if (!targetUser) {
        return reply.status(404).send({ message: "User not found" });
      }

      await blockRepo.block(blockerId, id);
      return reply.status(201).send({ message: "User blocked successfully" });
    }
  );

  // DELETE /users/me/block/:id — unblock a user
  app.delete(
    "/me/block/:id",
    { preHandler: [authenticate, activityMiddleware] },
    async (request, reply) => {
      const blockerId = request.user!.userId;
      const { id } = userIdParamSchema.parse(request.params);

      const removed = await blockRepo.unblock(blockerId, id);
      if (!removed) {
        return reply.status(404).send({ message: "Block not found" });
      }
      return reply.send({ message: "User unblocked successfully" });
    }
  );

  // PUT /users/:id — admin: update any user's profile fields (role, status, displayName)
  app.put(
    "/:id",
    { preHandler: [authenticate, requireRole("admin"), activityMiddleware] },
    async (request, reply) => {
      const { id } = userIdParamSchema.parse(request.params);

      // Prevent an admin from accidentally demoting / suspending themselves
      if (id === request.user!.userId) {
        return reply.status(400).send({ message: "Admins cannot modify their own account via this endpoint. Use PUT /users/me." });
      }

      let body: z.infer<typeof adminUpdateUserSchema>;
      try {
        body = adminUpdateUserSchema.parse(request.body);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return reply.status(400).send({ message: "Validation failed", errors: err.issues });
        }
        throw err;
      }

      if (!body.displayName && !body.role && !body.status) {
        return reply.status(400).send({ message: "No updatable fields provided." });
      }

      let objectId;
      try {
        objectId = new ObjectId(id);
      } catch {
        return reply.status(400).send({ message: "Invalid user ID format." });
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.displayName !== undefined) updates.displayName = body.displayName;
      if (body.role       !== undefined) updates.role        = body.role;
      if (body.status     !== undefined) updates.status      = body.status;

      try {
        const result = await usersCollection.findOneAndUpdate(
          { _id: objectId },
          { $set: updates },
          {
            returnDocument: "after",
            projection: { passwordHash: 0, resetPasswordToken: 0, resetPasswordExpires: 0 },
          }
        );

        if (!result) return reply.status(404).send({ message: "User not found" });

        return reply.send({
          id:          result._id.toString(),
          email:       result.email,
          role:        result.role,
          status:      result.status,
          displayName: result.displayName,
          avatarUrl:   result.avatarUrl ?? null,
        });
      } catch (err) {
        logger.error({ err }, "PUT /users/:id failed");
        return reply.status(500).send({ message: "Internal server error" });
      }
    }
  );

  // DELETE /users/:id — admin: permanently remove a user account
  app.delete(
    "/:id",
    { preHandler: [authenticate, requireRole("admin"), activityMiddleware] },
    async (request, reply) => {
      const { id } = userIdParamSchema.parse(request.params);

      if (id === request.user!.userId) {
        return reply.status(400).send({ message: "Admins cannot delete their own account." });
      }

      let objectId;
      try {
        objectId = new ObjectId(id);
      } catch {
        return reply.status(400).send({ message: "Invalid user ID format." });
      }

      try {
        const result = await usersCollection.deleteOne({ _id: objectId });
        if (result.deletedCount === 0) {
          return reply.status(404).send({ message: "User not found" });
        }
        return reply.status(200).send({ message: "User deleted successfully" });
      } catch (err) {
        logger.error({ err }, "DELETE /users/:id failed");
        return reply.status(500).send({ message: "Internal server error" });
      }
    }
  );

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
