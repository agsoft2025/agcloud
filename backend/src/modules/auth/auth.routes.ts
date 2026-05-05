import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { loginSchema } from "./auth.schemas.js";

const authRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post("/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    // TODO: implement authentication and JWT generation
    return { message: "login route placeholder", user: { email: body.email } };
  });

  app.post("/register", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    // TODO: implement user registration
    return { message: "register route placeholder", user: { email: body.email } };
  });
};

export default authRoutes;
