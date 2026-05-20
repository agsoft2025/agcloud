import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } from "./auth.schemas.js";
import { userSchema, UserDocument } from "../user/user.schemas.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import config from "../../config/index.js";
import { z } from "zod";
import { connectMongo } from "../../shared/db/mongo.client.js";

const authRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const db = await connectMongo();
  const usersCollection = db.collection<UserDocument>("users");

  //  POST  /auth/signin` | Authenticate, return tokens and set cookies
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

      reply.setCookie("token", token, {
        path: "/",
        httpOnly: true,
        secure: config.env === "production",
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60, // 7 days
      });

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
        return reply.status(400).send({
          message: "Validation failed",
          errors: error.issues,
        });
      }
      console.error(error);
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/signout  Revoke refresh token  Clear cookies
  app.post("/signout", async (request, reply) => {
    reply.clearCookie("token", { path: "/" });
    return reply.send({ message: "Logout successful" });
  });

  //  POST  auth/signup Register new user
  app.post("/signup", async (request, reply) => {
    try {
      // Validate request body
      const body = registerSchema.parse(request.body);
      console.log("<><>body", body)
      // Check existing user
      const existingUser = await usersCollection.findOne({ email: body.email });
      console.log("<><>existingUser", existingUser)
      if (existingUser) {
        return reply.status(409).send({
          message: "User already exists",
        });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(body.password, 10);
      console.log("<><>passwordHash", passwordHash)
      // Create user object
      const newUser = userSchema.parse({
        email: body.email,
        passwordHash,
        displayName: body.displayName,
        avatarUrl: body.avatarUrl,
        phoneNumber: body.phoneNumber,
      });

      // Insert into DB using the typed collection
      const result = await usersCollection.insertOne(newUser as UserDocument);
      console.log("<><>result", result)
      // Return response
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
        return reply.status(400).send({
          message: "Validation failed",
          errors: error.issues,
        });
      }

      console.error(error);

      return reply.status(500).send({
        message: "Internal server error",
      });
    }
  });

  //  POST /auth/forgot-password  Send reset email 
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
          {
            $set: {
              resetPasswordToken: resetTokenHash,
              resetPasswordExpires: expires
            }
          }
        );

        // TODO: Integrate email service here (e.g. SendGrid, AWS SES)
        console.log(`[DEV ONLY] Reset token for ${email}: ${resetToken}`);
      }

      // Always return success to prevent email enumeration
      return reply.send({ message: "If that email exists, a password reset link has been sent." });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ message: "Validation failed", errors: error.issues });
      }
      console.error(error);
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  //  POST /auth/reset-password Set new password with reset token 
  app.post("/reset-password", async (request, reply) => {
    try {
      const { token, newPassword } = resetPasswordSchema.parse(request.body);

      const resetTokenHash = crypto.createHash("sha256").update(token).digest("hex");

      const user = await usersCollection.findOne({
        resetPasswordToken: resetTokenHash,
        resetPasswordExpires: { $gt: new Date() }
      });

      if (!user) {
        return reply.status(400).send({ message: "Invalid or expired reset token" });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);

      await usersCollection.updateOne(
        { _id: user._id },
        {
          $set: { passwordHash },
          $unset: { resetPasswordToken: "", resetPasswordExpires: "" }
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
