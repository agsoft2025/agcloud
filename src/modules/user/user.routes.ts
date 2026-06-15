import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { UserRepository } from "./user.repository.js";
import { UserDocument } from "./user.schemas.js";
import { authenticate } from "../../shared/middleware/auth.middleware.js";

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

const userRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const userRepo = new UserRepository();

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
