import { describe, it, expect, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { registerRequestId } from "../../../src/shared/middleware/request-id.js";
import { getRequestContext } from "../../../src/shared/observability/request-context.js";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerRequestId(app);

  app.get("/whoami", async (request) => {
    return { requestId: (request as any).requestId, context: getRequestContext() };
  });

  await app.ready();
  return app;
}

describe("registerRequestId", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("echoes back an incoming x-request-id header as X-Request-ID and on request.requestId", async () => {
    app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: { "x-request-id": "incoming-id-123" },
    });

    expect(response.headers["x-request-id"]).toBe("incoming-id-123");
    expect(JSON.parse(response.payload).requestId).toBe("incoming-id-123");
  });

  it("generates a UUID when no request id header is present", async () => {
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/whoami" });

    const headerValue = response.headers["x-request-id"] as string;
    expect(headerValue).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(JSON.parse(response.payload).requestId).toBe(headerValue);
  });

  it("falls back to x-trace-id when x-request-id is absent", async () => {
    app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: { "x-trace-id": "trace-id-456" },
    });

    expect(response.headers["x-request-id"]).toBe("trace-id-456");
    expect(JSON.parse(response.payload).requestId).toBe("trace-id-456");
  });

  it("prefers x-request-id over x-trace-id when both are present", async () => {
    app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: { "x-request-id": "request-wins", "x-trace-id": "trace-loses" },
    });

    expect(response.headers["x-request-id"]).toBe("request-wins");
    expect(JSON.parse(response.payload).requestId).toBe("request-wins");
  });

  it("populates the AsyncLocalStorage request context so logger.ts's mixin can pick it up", async () => {
    app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: { "x-request-id": "ctx-id-789" },
    });

    expect(JSON.parse(response.payload).context).toEqual({ requestId: "ctx-id-789" });
  });
});
