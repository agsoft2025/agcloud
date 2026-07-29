import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "./auth.schemas.js";
import { userSchema, UserDocument } from "../user/user.schemas.js";
import config from "../../config/index.js";
import { z } from "zod";
import { connectMongo } from "../../shared/db/mongo.client.js";
import { ObjectId } from "mongodb";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { handleActivity } from "../presence/presence.service.js";
import { hashPassword, verifyPassword } from "../../shared/security/argon2.js";
import logger from "../../shared/observability/logger.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  decodeAccessTokenUnsafe,
  type RefreshTokenPayload,
} from "../../shared/security/jwt.js";
import { generateSecureToken, hashToken } from "../../shared/security/crypto.js";
import { getRedisClient } from "../../shared/db/redis.client.js";
import { writeAuditLog } from "../../shared/security/audit-log.js";
import { RefreshTokenRepository } from "./refresh-token.repository.js";
import { sendPasswordResetEmail } from "../../shared/email/email.service.js";
import type { DeviceInfo } from "./auth.types.js";

/**
 * Cookie policy:
 *  - "token" (access JWT) — path "/", short-lived (matches the ~15 min access
 *    token), sent on every request since `authenticate` needs it everywhere.
 *  - "refreshToken" (opaque-to-the-client rotation JWT) — path "/auth" only.
 *    It is never sent to non-auth routes, which shrinks its exposure surface
 *    (access logs, error trackers, unrelated middleware) to just the
 *    handful of endpoints that actually need it.
 */
function cookieOptions(request: FastifyRequest, kind: "access" | "refresh" = "access") {
  const isHttps =
    request.protocol === "https" ||
    request.headers["x-forwarded-proto"] === "https" ||
    config.env === "production";

  const base = {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? ("none" as const) : ("lax" as const),
  };

  if (kind === "refresh") {
    return {
      ...base,
      path: "/auth",
      maxAge: config.refreshTokenTtlDays * 24 * 60 * 60,
    };
  }

  return {
    ...base,
    path: "/",
    maxAge: 15 * 60, // 15 minutes - matches short-lived access token
  };
}

function getDeviceInfo(request: FastifyRequest): DeviceInfo {
  return {
    userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
    ip: request.ip ?? null,
  };
}

/**
 * Add an access token's jti to the Redis denylist for whatever time remains
 * until its natural expiry, so it stops working immediately instead of
 * lingering valid for up to another 15 minutes after signout/logout-all.
 */
async function denylistAccessToken(decoded: { jti?: string; exp?: number }): Promise<void> {
  if (!decoded.jti || !decoded.exp) return;
  const remainingSeconds = decoded.exp - Math.floor(Date.now() / 1000);
  if (remainingSeconds <= 0) return;

  try {
    await getRedisClient().set(`denylist:jti:${decoded.jti}`, "1", "EX", remainingSeconds);
  } catch (err) {
    logger.warn(
      { err, jti: decoded.jti },
      "Failed to denylist access token — it will remain valid until natural expiry"
    );
  }
}

function extractAccessToken(request: FastifyRequest): string | undefined {
  const authHeader = request.headers.authorization;
  const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearerToken ?? request.cookies.token;
}

function extractRefreshToken(request: FastifyRequest): string | undefined {
  return (
    ((request.body ?? {}) as { refreshToken?: string }).refreshToken ?? request.cookies.refreshToken
  );
}

// Strict rate limit: 10 requests per 15 minutes per IP. Used for endpoints
// not called out with their own limit in spec §5.4 (currently reset-password).
const authRateLimitConfig = {
  config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
};

// Spec §5.4: signin 5/min per IP, signup 3/min per IP.
const signinRateLimitConfig = {
  config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
};
const signupRateLimitConfig = {
  config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
};

// Spec §5.4: forgot-password is 1 req/5min per EMAIL, not per IP — a shared
// office/NAT IP must not let one user's requests exhaust another's budget,
// and a single IP spraying different emails should be caught elsewhere (the
// global per-IP limit), not conflated with this per-account limit.
// `hook: "preHandler"` is required so the body has already been parsed by
// the time the keyGenerator runs (the default `onRequest` hook fires before
// parsing).
const forgotPasswordRateLimitConfig = {
  config: {
    rateLimit: {
      max: 1,
      timeWindow: "5 minutes",
      hook: "preHandler" as const,
      keyGenerator: (request: FastifyRequest) =>
        (request.body as { email?: string } | undefined)?.email ?? request.ip,
    },
  },
};

const authRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const db = await connectMongo();
  const usersCollection = db.collection<UserDocument>("users");
  const refreshTokenRepo = new RefreshTokenRepository();

  // GET /auth/me
  app.get("/me", { preHandler: authenticate }, async (request, reply) => {
    try {
      const user = await usersCollection.findOne(
        { _id: new ObjectId(request.user!.userId) },
        { projection: { passwordHash: 0, resetPasswordToken: 0, resetPasswordExpires: 0 } }
      );

      if (!user || user.status === "suspended" || user.status === "deleted") {
        reply.clearCookie("token", cookieOptions(request, "access"));
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

  // GET /auth/sessions — list this user's active login sessions (one per device/family)
  app.get("/sessions", { preHandler: authenticate }, async (request, reply) => {
    try {
      const userId = request.user!.userId;
      let currentFamilyId: string | undefined;

      const rawRefreshToken = request.cookies.refreshToken;
      if (rawRefreshToken) {
        try {
          const decoded = verifyRefreshToken(rawRefreshToken);
          const stored = await refreshTokenRepo.findByJti(decoded.jti);
          currentFamilyId = stored?.familyId;
        } catch {
          // Current session's refresh token is invalid/expired — just omit isCurrent.
        }
      }

      const sessions = await refreshTokenRepo.listActiveSessionsForUser(userId, currentFamilyId);
      return reply.send({ sessions });
    } catch (error) {
      logger.error({ err: error }, "GET /auth/sessions failed");
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // DELETE /auth/sessions/:familyId — revoke one specific device/session ("sign out this device")
  app.delete("/sessions/:familyId", { preHandler: authenticate }, async (request, reply) => {
    try {
      const userId = request.user!.userId;
      const { familyId } = request.params as { familyId: string };
      const device = getDeviceInfo(request);

      const revoked = await refreshTokenRepo.revokeFamilyForUser(
        familyId,
        userId,
        "device_revoked"
      );
      if (!revoked) {
        return reply.status(404).send({ message: "Session not found" });
      }

      await writeAuditLog({
        event: "auth.session.revoked",
        severity: "info",
        userId,
        ip: device.ip,
        userAgent: device.userAgent,
        metadata: { familyId },
      });

      return reply.send({ message: "Session revoked" });
    } catch (error) {
      logger.error({ err: error }, "DELETE /auth/sessions/:familyId failed");
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/signup
  app.post("/signup", signupRateLimitConfig, async (request, reply) => {
    try {
      const body = registerSchema.parse(request.body);
      const device = getDeviceInfo(request);

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
      await writeAuditLog({
        event: "auth.signup",
        severity: "info",
        userId: result.insertedId.toString(),
        email: newUser.email,
        ip: device.ip,
        userAgent: device.userAgent,
      });

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
  app.post("/signin", signinRateLimitConfig, async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);
      const device = getDeviceInfo(request);

      const user = await usersCollection.findOne({ email: body.email });
      if (!user) {
        await writeAuditLog({
          event: "auth.signin.failed",
          severity: "warning",
          email: body.email,
          ip: device.ip,
          userAgent: device.userAgent,
          metadata: { reason: "no_such_user" },
        });
        return reply.status(401).send({ message: "Invalid email or password" });
      }

      const { valid, needsRehash } = await verifyPassword(body.password, user.passwordHash);
      if (!valid) {
        await writeAuditLog({
          event: "auth.signin.failed",
          severity: "warning",
          userId: user._id.toString(),
          email: body.email,
          ip: device.ip,
          userAgent: device.userAgent,
          metadata: { reason: "bad_password" },
        });
        return reply.status(401).send({ message: "Invalid email or password" });
      }

      // Opportunistically upgrade bcrypt hashes to argon2id on next successful login
      if (needsRehash) {
        const newHash = await hashPassword(body.password);
        await usersCollection.updateOne({ _id: user._id }, { $set: { passwordHash: newHash } });
        logger.info({ userId: user._id }, "Password rehashed to argon2id");
      }

      const userId = user._id.toString();
      const accessToken = signAccessToken(userId, user.email, user.role);
      const { jti: refreshJti, familyId } = await refreshTokenRepo.createFamily(userId, device);
      const refreshToken = signRefreshToken(userId, refreshJti);

      reply.setCookie("token", accessToken, cookieOptions(request, "access"));
      reply.setCookie("refreshToken", refreshToken, cookieOptions(request, "refresh"));
      handleActivity(userId).catch(() => {});

      await writeAuditLog({
        event: "auth.signin.success",
        severity: "info",
        userId,
        email: user.email,
        ip: device.ip,
        userAgent: device.userAgent,
        metadata: { familyId },
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
        // The access token is short-lived (~15 min) and is always returned in
        // the body too, since non-browser clients (mobile apps, service
        // integrations) can't rely on an httpOnly cookie jar. The refresh
        // token is far more powerful (it survives for days and is what
        // rotation/revocation is built around), so it is deliberately kept
        // out of the JSON body in production and delivered only via the
        // httpOnly cookie, which JavaScript — including an XSS payload —
        // cannot read.
        accessToken,
        token: accessToken,
      };

      if (config.env !== "production") {
        responsePayload.refreshToken = refreshToken;
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
  //
  // Real rotation semantics: every refresh token is single-use. Presenting
  // one that has already been rotated away is treated as token theft and
  // revokes the entire session family, not just the one token — this is what
  // makes a stolen (but not-yet-used) refresh token worthless the moment the
  // legitimate client rotates past it, and what makes a stolen *and used*
  // refresh token detectable the moment the legitimate client tries to use
  // its now-superseded copy again.
  app.post("/refresh", async (request, reply) => {
    try {
      const rawRefreshToken = extractRefreshToken(request);
      const device = getDeviceInfo(request);

      if (!rawRefreshToken) {
        return reply.status(401).send({ message: "Authentication required" });
      }

      let decoded: RefreshTokenPayload;
      try {
        decoded = verifyRefreshToken(rawRefreshToken);
      } catch {
        await writeAuditLog({
          event: "auth.refresh.invalid",
          severity: "warning",
          ip: device.ip,
          userAgent: device.userAgent,
          metadata: { reason: "bad_signature_or_expired" },
        });
        return reply.status(401).send({ message: "Invalid or expired session" });
      }

      const stored = await refreshTokenRepo.findByJti(decoded.jti);
      if (!stored) {
        await writeAuditLog({
          event: "auth.refresh.invalid",
          severity: "warning",
          userId: decoded.userId,
          ip: device.ip,
          userAgent: device.userAgent,
          metadata: { reason: "no_record" },
        });
        return reply.status(401).send({ message: "Invalid or expired session" });
      }

      if (stored.revoked) {
        return reply
          .status(401)
          .send({ message: "Session has been revoked. Please sign in again." });
      }

      if (stored.used) {
        await refreshTokenRepo.revokeFamily(stored.familyId, "reuse_detected");
        await writeAuditLog({
          event: "auth.refresh.reuse_detected",
          severity: "critical",
          userId: stored.userId,
          ip: device.ip,
          userAgent: device.userAgent,
          metadata: { familyId: stored.familyId, jti: stored.jti },
        });
        return reply
          .status(401)
          .send({
            message: "Security alert: this session has been revoked. Please sign in again.",
          });
      }

      const familyAgeMs = Date.now() - stored.familyCreatedAt.getTime();
      const familyMaxAgeMs = config.refreshTokenFamilyMaxAgeDays * 24 * 60 * 60 * 1000;
      if (familyAgeMs > familyMaxAgeMs) {
        await refreshTokenRepo.revokeFamily(stored.familyId, "family_expired");
        await writeAuditLog({
          event: "auth.refresh.family_expired",
          severity: "info",
          userId: stored.userId,
          ip: device.ip,
          userAgent: device.userAgent,
          metadata: { familyId: stored.familyId },
        });
        return reply.status(401).send({ message: "Session expired. Please sign in again." });
      }

      const user = await usersCollection.findOne({ _id: new ObjectId(stored.userId) });
      if (!user || user.status === "suspended" || user.status === "deleted") {
        return reply.status(401).send({ message: "Invalid or expired session" });
      }

      const { jti: newJti } = await refreshTokenRepo.rotate(stored);
      const newRefreshToken = signRefreshToken(stored.userId, newJti);
      const newAccessToken = signAccessToken(stored.userId, user.email, user.role);

      reply.setCookie("token", newAccessToken, cookieOptions(request, "access"));
      reply.setCookie("refreshToken", newRefreshToken, cookieOptions(request, "refresh"));
      handleActivity(stored.userId).catch(() => {});

      await writeAuditLog({
        event: "auth.refresh.success",
        severity: "info",
        userId: stored.userId,
        ip: device.ip,
        userAgent: device.userAgent,
        metadata: { familyId: stored.familyId },
      });

      const responsePayload: any = { accessToken: newAccessToken, token: newAccessToken };
      if (config.env !== "production") {
        responsePayload.refreshToken = newRefreshToken;
      }

      return reply.send(responsePayload);
    } catch (error: any) {
      logger.error({ err: error }, "POST /auth/refresh failed");
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/signout
  //
  // Unlike the old implementation, this actually revokes server-side state:
  // the current refresh-token family is killed (so it can never be rotated
  // again) and the current access token's jti is denylisted (so it stops
  // working immediately instead of drifting for up to another 15 minutes).
  app.post("/signout", async (request, reply) => {
    let userId: string | undefined;

    try {
      const device = getDeviceInfo(request);
      const accessToken = extractAccessToken(request);
      const rawRefreshToken = extractRefreshToken(request);

      if (accessToken) {
        const decoded = decodeAccessTokenUnsafe(accessToken);
        if (decoded) {
          userId = decoded.userId;
          await denylistAccessToken(decoded);
        }
      }

      if (rawRefreshToken) {
        try {
          const decoded = verifyRefreshToken(rawRefreshToken);
          userId = userId ?? decoded.userId;
          const stored = await refreshTokenRepo.findByJti(decoded.jti);
          if (stored) {
            await refreshTokenRepo.revokeFamily(stored.familyId, "logout");
          }
        } catch {
          // Already invalid/expired — nothing left to revoke.
        }
      }

      await writeAuditLog({
        event: "auth.signout",
        severity: "info",
        userId,
        ip: device.ip,
        userAgent: device.userAgent,
      });
    } catch (error) {
      // Signout must never fail the client-visible flow — log and fall through
      // to clearing cookies regardless.
      logger.error(
        { err: error },
        "POST /auth/signout encountered an error (cookies still cleared)"
      );
    }

    reply.clearCookie("token", cookieOptions(request, "access"));
    reply.clearCookie("refreshToken", cookieOptions(request, "refresh"));
    return reply.send({ message: "Logout successful" });
  });

  // POST /auth/logout-all — revoke every session for this user, on every device.
  app.post("/logout-all", { preHandler: authenticate }, async (request, reply) => {
    try {
      const userId = request.user!.userId;
      const device = getDeviceInfo(request);

      await refreshTokenRepo.revokeAllForUser(userId, "logout_all");

      const accessToken = extractAccessToken(request);
      if (accessToken) {
        const decoded = decodeAccessTokenUnsafe(accessToken);
        if (decoded) await denylistAccessToken(decoded);
      }

      reply.clearCookie("token", cookieOptions(request, "access"));
      reply.clearCookie("refreshToken", cookieOptions(request, "refresh"));

      await writeAuditLog({
        event: "auth.logout_all",
        severity: "info",
        userId,
        ip: device.ip,
        userAgent: device.userAgent,
      });

      // Note on propagation: this device's access token is denylisted
      // immediately. Other devices' access tokens are not individually
      // denylisted (we don't track their jtis), but every refresh-token
      // family is revoked, so those devices lose access within their
      // current access token's remaining lifetime (≤15 minutes) the moment
      // they next try to refresh.
      return reply.send({
        message: "Logged out of all devices. Every active session has been revoked.",
      });
    } catch (error) {
      logger.error({ err: error }, "POST /auth/logout-all failed");
      return reply.status(500).send({ message: "Internal server error" });
    }
  });

  // POST /auth/forgot-password
  app.post("/forgot-password", forgotPasswordRateLimitConfig, async (request, reply) => {
    try {
      const { email } = forgotPasswordSchema.parse(request.body);
      const user = await usersCollection.findOne({ email });
      const device = getDeviceInfo(request);

      if (user) {
        const resetToken = generateSecureToken(32);
        const resetTokenHash = hashToken(resetToken);
        const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await usersCollection.updateOne(
          { _id: user._id },
          { $set: { resetPasswordToken: resetTokenHash, resetPasswordExpires: expires } }
        );

        // sendPasswordResetEmail never rejects — delivery failures are logged
        // internally so they can't turn a password-reset request into a 500.
        await sendPasswordResetEmail(email, resetToken);

        await writeAuditLog({
          event: "auth.password_reset.requested",
          severity: "info",
          userId: user._id.toString(),
          email,
          ip: device.ip,
          userAgent: device.userAgent,
        });
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
      const device = getDeviceInfo(request);

      const resetTokenHash = hashToken(token);
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

      // A password reset is a strong account-recovery signal — invalidate
      // every existing session so a session hijacked before the reset
      // (e.g. via a stolen refresh token) cannot survive it.
      await refreshTokenRepo.revokeAllForUser(user._id.toString(), "logout_all");

      await writeAuditLog({
        event: "auth.password_reset.completed",
        severity: "info",
        userId: user._id.toString(),
        email: user.email,
        ip: device.ip,
        userAgent: device.userAgent,
      });

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
