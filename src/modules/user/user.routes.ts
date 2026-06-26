import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { UserRepository } from "./user.repository.js";
import { UserDocument } from "./user.schemas.js";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { ObjectId } from "mongodb";
import { connectMongo } from "../../shared/db/mongo.client.js";
import { z } from "zod";

function toContact(user: UserDocument) {
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
    presenceStatus: user.presenceStatus ?? "offline",
    lastSeenAt: user.lastSeenAt,
  };
}

const updateProfileSchema = z.object({
  displayName: z
    .string()
    .min(2, "Display name must be at least 2 characters")
    .max(50, "Display name must be at most 50 characters")
    .optional(),
  // Accepts regular URLs and data URLs (base64-encoded avatars)
  avatarUrl: z.string().optional(),
});

const userRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const userRepo = new UserRepository();
  const db = await connectMongo();
  const usersCollection = db.collection<UserDocument>("users");

  // GET /users - list active, non-blocked users with search & pagination
  app.get("/", { preHandler: authenticate }, async (request, reply) => {
    const query = request.query as { page?: string; limit?: string; search?: string };

    const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? "20", 10) || 20));

    const { users, total } = await userRepo.listContacts({
      page,
      limit,
      search: query.search,
      excludeUserId: request.user?.userId,
    });

    return reply.send({
      users: users.map(toContact),
      total,
      page,
      limit,
    });
  });

  // GET /users/presence - presence status for all users
  app.get("/presence", { preHandler: authenticate }, async (_request, reply) => {
    const presence = await userRepo.getAllPresence();
    return reply.send(
      presence.map((p) => ({
        userId: p.userId,
        status: p.status,
        lastSeen: p.lastSeen,
      }))
    );
  });

  // PUT /users/me - update the authenticated user's own profile
  app.put("/me", { preHandler: authenticate }, async (request, reply) => {
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

      if (!result) {
        return reply.status(404).send({ message: "User not found" });
      }

      return reply.send({
        id: result._id,
        email: result.email,
        role: result.role,
        status: result.status,
        displayName: result.displayName,
        avatarUrl: result.avatarUrl ?? null,
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ message: "Validation failed", errors: error.issues });
      }
      console.error(error);
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // GET /users/:id - fetch a single user profile
  app.get("/:id", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await userRepo.getUserById(id);

    if (!user) {
      return reply.status(404).send({ message: "User not found" });
    }

    return reply.send(toContact(user));
  });
};

export default userRoutes;
