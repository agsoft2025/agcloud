import { describe, it, expect, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { z } from "zod";
import { registerErrorHandler } from "../../../src/shared/middleware/error-handler.js";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);

  app.get("/zod-error", async () => {
    const schema = z.object({ name: z.string() });
    schema.parse({ name: 123 }); // throws a ZodError
  });

  app.get("/generic-error", async () => {
    throw new Error("something broke");
  });

  app.get("/custom-status", async () => {
    const err = new Error("teapot") as Error & { statusCode: number };
    err.statusCode = 418;
    throw err;
  });

  app.get(
    "/schema-validated",
    { schema: { querystring: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } } },
    async () => ({ ok: true })
  );

  await app.ready();
  return app;
}

describe("registerErrorHandler", () => {
  let app: FastifyInstance;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    if (app) await app.close();
  });

  it("returns 400 with an issues array for a thrown ZodError", async () => {
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/zod-error" });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("Validation Error");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues[0]).toHaveProperty("path");
    expect(body.issues[0]).toHaveProperty("message");
  });

  it("returns 500 with no stack field when NODE_ENV=production", async () => {
    process.env.NODE_ENV = "production";
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/generic-error" });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("Internal Server Error");
    expect(body).not.toHaveProperty("stack");
  });

  it("returns 500 WITH a stack field when NODE_ENV is not production", async () => {
    process.env.NODE_ENV = "test";
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/generic-error" });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("Internal Server Error");
    expect(body).toHaveProperty("stack");
    expect(typeof body.stack).toBe("string");
  });

  it("honours a custom statusCode property on the error", async () => {
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/custom-status" });

    expect(response.statusCode).toBe(418);
    const body = JSON.parse(response.payload);
    // statusCode < 500 => message passed through as `error`
    expect(body.error).toBe("teapot");
  });

  it("returns 400 with a validation issues array for a Fastify schema-validation failure", async () => {
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/schema-validated" }); // missing required "n"

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("Validation Error");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("returns the custom not-found shape for an unregistered route", async () => {
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/does-not-exist" });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("Not Found");
    expect(body.message).toContain("/does-not-exist");
  });
});
