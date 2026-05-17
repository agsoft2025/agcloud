import { z } from "zod";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

export default async function authRoutes(app) {
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
}
