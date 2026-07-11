import { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import config from "../../config/index.js";
import { getRedisClient } from "../db/redis.client.js";
import logger from "../observability/logger.js";

export interface UserPayload {
  userId: string;
  email: string;
  jti?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: UserPayload;
  }
}

/**
 * Returns true if this access token's jti has been explicitly revoked
 * (logout / logout-everywhere) before its natural expiry.
 *
 * Fails OPEN on a Redis error: a Redis outage degrades revocation to
 * "wait out the access token's own ≤15-minute expiry" rather than taking
 * down all authenticated traffic. This matches the fail-open posture already
 * used elsewhere in this codebase (idempotency, rate-limit Redis store) and
 * is a deliberate availability/security trade-off, not an oversight — bound
 * by the short access-token TTL.
 */
async function isDenylisted(jti: string): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const value = await redis.get(`denylist:jti:${jti}`);
    return value !== null;
  } catch (err) {
    logger.warn({ err, jti }, "Denylist check failed — failing open");
    return false;
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization;
    const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = bearerToken ?? request.cookies.token;

    if (!token) {
      return reply.status(401).send({ message: "Authentication required" });
    }

    const decoded = jwt.verify(token, config.jwtSecret) as UserPayload;

    if (decoded.jti && (await isDenylisted(decoded.jti))) {
      return reply.status(401).send({ message: "Session has been revoked" });
    }

    request.user = decoded;
  } catch (error) {
    return reply.status(401).send({ message: "Invalid or expired token" });
  }
}
