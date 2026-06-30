/**
 * Lightweight request tracing — attaches a unique requestId to every request
 * so correlated logs can be filtered by request.
 *
 * For full distributed tracing (OpenTelemetry + Jaeger/Tempo), replace this
 * with the @opentelemetry/sdk-node setup and remove this file.
 */

import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";

export function registerTracing(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    // Honour an upstream trace-id if provided (e.g. from an API gateway)
    const incoming =
      request.headers["x-request-id"] ??
      request.headers["x-trace-id"] ??
      randomUUID();

    (request as any).requestId = incoming;
    request.log = request.log.child({ requestId: incoming });
  });
}
