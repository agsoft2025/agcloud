import { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import config from "../../config/index.js";

export interface UserPayload {
  userId: string;
  email: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: UserPayload;
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
    request.user = decoded;
  } catch (error) {
    return reply.status(401).send({ message: "Invalid or expired token" });
  }
}
