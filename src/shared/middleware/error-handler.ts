import { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import logger from "../observability/logger.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: "Validation Error",
          message: "Request validation failed",
          issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }

      const fastifyError = error as FastifyError;
      if (fastifyError.statusCode === 400 && fastifyError.validation) {
        return reply.status(400).send({
          error: "Validation Error",
          message: error.message,
          issues: fastifyError.validation,
        });
      }

      const statusCode = typeof fastifyError.statusCode === "number" ? fastifyError.statusCode : 500;

      if (statusCode >= 500) {
        logger.error(
          { err: error, requestId: (request as any).requestId, method: request.method, url: request.url },
          "Unhandled server error"
        );
      } else {
        logger.warn(
          { statusCode, message: error.message, requestId: (request as any).requestId },
          "Client error"
        );
      }

      const isProduction = process.env.NODE_ENV === "production";
      return reply.status(statusCode).send({
        error: statusCode >= 500 ? "Internal Server Error" : error.message,
        ...(isProduction ? {} : { stack: error.stack }),
      });
    }
  );

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: "Not Found",
      message: `Route ${request.method} ${request.url} not found`,
    });
  });
}
