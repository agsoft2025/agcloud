import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";

/**
 * Attach a unique request ID to every request.
 * Honours X-Request-ID from upstream proxies/gateways.
 * Echoed back in the response as X-Request-ID.
 */
export function registerRequestId(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const incoming =
      (request.headers["x-request-id"] as string) ??
      (request.headers["x-trace-id"] as string) ??
      randomUUID();

    (request as any).requestId = incoming;
    reply.header("X-Request-ID", incoming);
  });
}
