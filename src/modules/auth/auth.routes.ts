import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } from "./auth.schemas.js";
import { userSchema, UserDocument } from "../user/user.schemas.js";
import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "crypto";
import config from "../../config/index.js";
import { z } from "zod";
import { connectMongo } from "../../shared/db/mongo.client.js";
import { ObjectId } from "mongodb";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { handleActivity } from "../presence/presence.service.js";
import { hashPassword, verifyPassword } from "../../shared/security/argon2.js";
import logger from "../../shared/observability/logger.js";

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
    maxAge: 15 * 60, // 15 minutes - matches short-lived access token
  };
}

function signToken(userId: string, email: string): string {
  return jwt.sign(
    { userId, email, type: "access" },
    config.jwtSecret,
    { expiresIn: config.jwtAccessTokenExpiresIn as any }
  );
}

// Strict rate limit: 10 requests per 15 minutes per IP
const authRateLimitConfig = {
  config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
};

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
      logger.error({ err: error }, "GET /auth/me failed");
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/signup
  app.post("/signup", authRateLimitConfig, async (request, reply) => {
    try {
      const body = registerSchema.parse(request.body);

      const existingUser = await usersCollection.findOne({ email: body.email });
      if (existingUser) {
        return reply.status(409).send({ message: "User already exists" });
      }

      // argon2id - OWASP recommended
      const passwordHash = await hashPassword(body.password);

      const newUser = userSchema.parse({
        email: body.email,
        passwordHash,
        displayName: body.displayName,
        avatarUrl: body.avatarUrl,
        phoneNumber: body.phoneNumber,
      });

      const result = await usersCollection.insertOne(newUser as UserDocument);

      logger.info({ userId: result.insertedId }, "New user registered");

      return reply.status(201).send({
        message: "User registered successfully",
        user: { id: result.insertedId, email: newUser.email, displayName: newUser.displayName },
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ message: "Validation failed", errors: error.issues });
      }
      logger.error({ err: error }, "POST /auth/signup failed");
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/signin
  app.post("/signin", authRateLimitConfig, async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);

      const user = await usersCollection.findOne({ email: body.email });
      if (!user) {
        return reply.status(401).send({ message: "Invalid email or password" });
      }

      const { valid, needsRehash } = await verifyPassword(body.password, user.passwordHash);
      if (!valid) {
        return reply.status(401).send({ message: "Invalid email or password" });
      }

      // Opportunistically upgrade bcrypt hashes to argon2id on next successful login
      if (needsRehash) {
        const newHash = await hashPassword(body.password);
        await usersCollection.updateOne({ _id: user._id }, { $set: { passwordHash: newHash } });
        logger.info({ userId: user._id }, "Password rehashed to argon2id");
      }

      const token = signToken(user._id.toString(), user.email);
      reply.setCookie("token", token, cookieOptions(request));
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

      // Expose token in non-prod for Postman testing
      if (config.env !== "production") {
        responsePayload.token = token;
      }

      return reply.send(responsePayload);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ message: "Validation failed", errors: error.issues });
      }
      logger.error({ err: error }, "POST /auth/signin failed");
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/refresh
  app.post("/refresh", async (request, reply) => {
    try {
      const existingToken =
        ((request.body ?? {}) as { refreshToken?: string }).refreshToken ??
        request.cookies.token;

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

      const token = signToken(user._id.toString(), user.email);
      reply.setCookie("token", token, cookieOptions(request));
      handleActivity(user._id.toString()).catch(() => {});

      return reply.send({ accessToken: token, token });
    } catch (error: any) {
      logger.error({ err: error }, "POST /auth/refresh failed");
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/signout
  app.post("/signout", async (request, reply) => {
    reply.clearCookie("token", cookieOptions(request));
    return reply.send({ message: "Logout successful" });
  });

  // POST /auth/forgot-password
  app.post("/forgot-password", authRateLimitConfig, async (request, reply) => {
    try {
      const { email } = forgotPasswordSchema.parse(request.body);
      const user = await usersCollection.findOne({ email });

      if (user) {
        const resetToken = randomBytes(32).toString("hex");
        const resetTokenHash = createHash("sha256").update(resetToken).digest("hex");
        const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await usersCollection.updateOne(
          { _id: user._id },
          { $set: { resetPasswordToken: resetTokenHash, resetPasswordExpires: expires } }
        );

        // In production: send resetToken via email. In dev: log for Postman testing.
        if (config.env !== "production") {
          logger.debug({ email, resetToken }, "[DEV] Password reset token");
        }
      }

      // Always respond with same message to prevent email enumeration
      return reply.send({ message: "If that email exists, a password reset link has been sent." });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ message: "Validation failed", errors: error.issues });
      }
      logger.error({ err: error }, "POST /auth/forgot-password failed");
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/reset-password
  app.post("/reset-password", authRateLimitConfig, async (request, reply) => {
    try {
      const { token, newPassword } = resetPasswordSchema.parse(request.body);

      const resetTokenHash = createHash("sha256").update(token).digest("hex");
      const user = await usersCollection.findOne({
        resetPasswordToken: resetTokenHash,
        resetPasswordExpires: { $gt: new Date() },
      });

      if (!user) {
        return reply.status(400).send({ message: "Invalid or expired reset token" });
      }

      const passwordHash = await hashPassword(newPassword);

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
      logger.error({ err: error }, "POST /auth/reset-password failed");
      return reply.status(500).send({ message: "Internal server error" });
    }
  });
};

export default authRoutes;
