import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } from "./auth.schemas.js";
import { userSchema, UserDocument } from "../user/user.schemas.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import config from "../../config/index.js";
import { z } from "zod";
import { connectMongo } from "../../shared/db/mongo.client.js";
import { ObjectId } from "mongodb";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { handleActivity } from "../presence/presence.service.js";

function cookieOptions(request: FastifyRequest) {
  const isHttps =
    request.protocol === "https" ||
    request.headers["x-forwarded-proto"] === "https" ||
    config.env === "production";

  return {
    path: "/",
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? ("none" as const) : ("lax" as const),
    maxAge: 7 * 24 * 60 * 60,
  };
}

const authRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const db = await connectMongo();
  const usersCollection = db.collection<UserDocument>("users");

  // GET /auth/me
  app.get("/me", { preHandler: authenticate }, async (request, reply) => {
    try {
      const user = await usersCollection.findOne(
        { _id: new ObjectId(request.user!.userId) },
        { projection: { passwordHash: 0, resetPasswordToken: 0, resetPasswordExpires: 0 } }
      );

      if (!user || user.status === "suspended" || user.status === "deleted") {
        reply.clearCookie("token", cookieOptions(request));
        return reply.status(401).send({ message: "Authentication required" });
      }

      // Update presence on every session resume (page reload, app open).
      handleActivity(user._id.toString()).catch(() => {});

      return reply.send({
        id: user._id,
        email: user.email,
        role: user.role,
        status: user.status,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl ?? null,
      });
    } catch (error) {
      console.error(error);
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/signin
  app.post("/signin", async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);

      const user = await usersCollection.findOne({ email: body.email });
      if (!user) {
        return reply.status(401).send({ message: "Invalid email or password" });
      }

      const isPasswordValid = await bcrypt.compare(body.password, user.passwordHash);
      if (!isPasswordValid) {
        return reply.status(401).send({ message: "Invalid email or password" });
      }

      const token = jwt.sign(
        { userId: user._id.toString(), email: user.email },
        config.jwtSecret,
        { expiresIn: config.jwtAccessTokenExpiresIn as any }
      );

      reply.setCookie("token", token, cookieOptions(request));

      // Create Redis presence immediately on login so other users see this user
      // as ONLINE right away (not deferred until Socket.IO connection completes).
      handleActivity(user._id.toString()).catch(() => {});

      const responsePayload: any = {
        message: "Login successful",
        user: {
          id: user._id,
          email: user.email,
          role: user.role,
          status: user.status,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
        },
      };

      if (config.env !== "production") {
        responsePayload.token = token;
      }

      return reply.send(responsePayload);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ message: "Validation failed", errors: error.issues });
      }
      console.error(error);
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/refresh
  app.post("/refresh", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { refreshToken?: string };
      const existingToken = body.refreshToken ?? request.cookies.token;

      if (!existingToken) {
        return reply.status(401).send({ message: "Authentication required" });
      }

      let decoded: { userId: string; email: string };
      try {
        decoded = jwt.verify(existingToken, config.jwtSecret, { ignoreExpiration: true }) as {
          userId: string;
          email: string;
        };
      } catch {
        return reply.status(401).send({ message: "Invalid or expired token" });
      }

      const user = await usersCollection.findOne({ _id: new ObjectId(decoded.userId) });
      if (!user || user.status === "suspended" || user.status === "deleted") {
        return reply.status(401).send({ message: "Invalid or expired token" });
      }

      const token = jwt.sign(
        { userId: user._id.toString(), email: user.email },
        config.jwtSecret,
        { expiresIn: config.jwtAccessTokenExpiresIn as any }
      );

      reply.setCookie("token", token, cookieOptions(request));

      // Refresh = user is still active; update presence.
      handleActivity(user._id.toString()).catch(() => {});

      return reply.send({ accessToken: token, token });
    } catch (error: any) {
      console.error(error);
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/signout
  app.post("/signout", async (request, reply) => {
    reply.clearCookie("token", cookieOptions(request));
    return reply.send({ message: "Logout successful" });
  });

  // POST /auth/signup
  app.post("/signup", async (request, reply) => {
    try {
      const body = registerSchema.parse(request.body);

      const existingUser = await usersCollection.findOne({ email: body.email });
      if (existingUser) {
        return reply.status(409).send({ message: "User already exists" });
      }

      const passwordHash = await bcrypt.hash(body.password, 10);

      const newUser = userSchema.parse({
        email: body.email,
        passwordHash,
        displayName: body.displayName,
        avatarUrl: body.avatarUrl,
        phoneNumber: body.phoneNumber,
      });

      const result = await usersCollection.insertOne(newUser as UserDocument);

      return reply.status(201).send({
        message: "User registered successfully",
        user: {
          id: result.insertedId,
          email: newUser.email,
          displayName: newUser.displayName,
        },
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ message: "Validation failed", errors: error.issues });
      }
      console.error(error);
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/forgot-password
  app.post("/forgot-password", async (request, reply) => {
    try {
      const { email } = forgotPasswordSchema.parse(request.body);
      const user = await usersCollection.findOne({ email });

      if (user) {
        const resetToken = crypto.randomBytes(32).toString("hex");
        const resetTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
        const expires = new Date();
        expires.setHours(expires.getHours() + 1);

        await usersCollection.updateOne(
          { _id: user._id },
          { $set: { resetPasswordToken: resetTokenHash, resetPasswordExpires: expires } }
        );

        console.log("[DEV ONLY] Reset token for " + email + ": " + resetToken);
      }

      return reply.send({ message: "If that email exists, a password reset link has been sent." });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ message: "Validation failed", errors: error.issues });
      }
      console.error(error);
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/reset-password
  app.post("/reset-password", async (request, reply) => {
    try {
      const { token, newPassword } = resetPasswordSchema.parse(request.body);

      const resetTokenHash = crypto.createHash("sha256").update(token).digest("hex");

      const user = await usersCollection.findOne({
        resetPasswordToken: resetTokenHash,
        resetPasswordExpires: { $gt: new Date() },
      });

      if (!user) {
        return reply.status(400).send({ message: "Invalid or expired reset token" });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);

      await usersCollection.updateOne(
        { _id: user._id },
        {
          $set: { passwordHash },
          $unset: { resetPasswordToken: "", resetPasswordExpires: "" },
        }
      );

      return reply.send({ message: "Password has been successfully reset" });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ message: "Validation failed", errors: error.issues });
      }
      console.error(error);
      return reply.status(500).send({ message: "Internal server error" });
    }
  });
};

export default authRoutes;
