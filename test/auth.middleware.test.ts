import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { authenticate } from "../src/shared/middleware/auth.middleware.js";
import config from "../src/config/index.js";

function createReply() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

describe("authenticate middleware", () => {
  it("authenticates bearer tokens from the Authorization header", async () => {
    const token = jwt.sign({ userId: "user-1", email: "user@example.com" }, config.jwtSecret);
    const request = {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    } as any;
    const reply = createReply() as any;

    await authenticate(request, reply);

    expect(reply.statusCode).toBe(200);
    expect(request.user).toEqual({ userId: "user-1", email: "user@example.com", iat: expect.any(Number) });
  });

  it("falls back to the token cookie", async () => {
    const token = jwt.sign({ userId: "user-2", email: "cookie@example.com" }, config.jwtSecret);
    const request = {
      headers: {},
      cookies: { token },
    } as any;
    const reply = createReply() as any;

    await authenticate(request, reply);

    expect(reply.statusCode).toBe(200);
    expect(request.user).toEqual({ userId: "user-2", email: "cookie@example.com", iat: expect.any(Number) });
  });
});
