import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { enterRequestContext } from "../observability/request-context.js";

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
    // Must run first (registerRequestId is registered before every other
    // hook in app.ts) so every subsequent hook/handler's log calls — which
    // all go through the shared `logger` singleton, not `request.log` — pick
    // this requestId up automatically via logger.ts's pino `mixin`.
    enterRequestContext({ requestId: incoming });
  });
}
