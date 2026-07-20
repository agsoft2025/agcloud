import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { resetFakes, getFakeRedis } from "../../helpers/mockDb.js";
import { authenticate } from "../../../src/shared/middleware/auth.middleware.js";
import { mintAccessToken } from "../../helpers/fixtures.js";

async function buildApp() {
  const app = Fastify();
  await app.register(cookie);
  app.get("/protected", { preHandler: authenticate }, async (request) => ({ user: request.user }));
  return app;
}

describe("authenticate middleware", () => {
  beforeEach(() => resetFakes());
  afterEach(() => vi.restoreAllMocks());

  it("authenticates a valid Bearer token", async () => {
    const app = await buildApp();
    const token = mintAccessToken("user-1", "u1@example.com");

    const response = await app.inject({ method: "GET", url: "/protected", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload).user.userId).toBe("user-1");
    await app.close();
  });

  it("authenticates a valid token cookie", async () => {
    const app = await buildApp();
    const token = mintAccessToken("user-2", "u2@example.com");

    const response = await app.inject({ method: "GET", url: "/protected", headers: { cookie: `token=${token}` } });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("returns 401 when no token is presented", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/protected" });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.payload).message).toBe("Authentication required");
    await app.close();
  });

  it("returns 401 for a malformed/invalid token", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer not-a-real-jwt" },
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.payload).message).toBe("Invalid or expired token");
    await app.close();
  });

  it("returns 401 when the token's jti has been denylisted", async () => {
    const app = await buildApp();
    const token = mintAccessToken("user-3", "u3@example.com");

    // Decode without verifying just to grab the jti for denylisting.
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    await getFakeRedis().set(`denylist:jti:${payload.jti}`, "1");

    const response = await app.inject({ method: "GET", url: "/protected", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.payload).message).toBe("Session has been revoked");
    await app.close();
  });

  it("fails open (still authenticates) when the denylist check itself errors", async () => {
    const app = await buildApp();
    const token = mintAccessToken("user-4", "u4@example.com");
    vi.spyOn(getFakeRedis(), "get").mockRejectedValueOnce(new Error("redis down"));

    const response = await app.inject({ method: "GET", url: "/protected", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
