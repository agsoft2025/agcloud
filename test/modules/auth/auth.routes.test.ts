import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../../helpers/buildTestApp.js";
import { getFakeDb, resetFakes } from "../../helpers/mockDb.js";
import logger from "../../../src/shared/observability/logger.js";

describe("Auth Routes", () => {
  let app: FastifyInstance;

  const testUser = {
    email: "test-user@example.com",
    password: "password123",
    displayName: "Test User",
  };

  beforeEach(async () => {
    resetFakes();
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  describe("POST /auth/signup", () => {
    it("registers a new user", async () => {
      const response = await app.inject({ method: "POST", url: "/auth/signup", payload: testUser });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe("User registered successfully");
      expect(body.user.email).toBe(testUser.email);
    });

    it("rejects a duplicate email with 409", async () => {
      await app.inject({ method: "POST", url: "/auth/signup", payload: testUser });
      const response = await app.inject({ method: "POST", url: "/auth/signup", payload: testUser });
      expect(response.statusCode).toBe(409);
    });

    it("rejects invalid payloads with 400", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/signup",
        payload: { email: "not-an-email", password: "123" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("returns 500 when insertOne throws an unexpected error", async () => {
      vi.spyOn(getFakeDb().collection("users"), "insertOne").mockRejectedValueOnce(new Error("db down"));
      const response = await app.inject({ method: "POST", url: "/auth/signup", payload: testUser });
      expect(response.statusCode).toBe(500);
    });
  });

  describe("POST /auth/signin", () => {
    beforeEach(async () => {
      await app.inject({ method: "POST", url: "/auth/signup", payload: testUser });
    });

    it("logs in with correct credentials and sets cookies", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/signin",
        payload: { email: testUser.email, password: testUser.password },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe("Login successful");
      expect(body.user.email).toBe(testUser.email);
      expect(body.accessToken).toBeTruthy();
      expect(body.refreshToken).toBeTruthy(); // present outside production
      const cookies = response.headers["set-cookie"];
      expect(cookies).toBeDefined();
    });

    it("rejects an unknown email with 401", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/signin",
        payload: { email: "nobody@example.com", password: "whatever123" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("rejects an incorrect password with 401", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/signin",
        payload: { email: testUser.email, password: "wrongpassword" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("rehashes a legacy bcrypt password to argon2id on successful login", async () => {
      const bcrypt = await import("bcrypt");
      const legacyHash = await bcrypt.hash(testUser.password, 10);
      await getFakeDb().collection("users").updateOne({ email: testUser.email }, { $set: { passwordHash: legacyHash } });

      const response = await app.inject({
        method: "POST",
        url: "/auth/signin",
        payload: { email: testUser.email, password: testUser.password },
      });
      expect(response.statusCode).toBe(200);

      const updated = await getFakeDb().collection("users").findOne({ email: testUser.email });
      expect((updated as any).passwordHash.startsWith("$argon2")).toBe(true);
    });

    it("returns 500 on an unexpected error", async () => {
      vi.spyOn(getFakeDb().collection("users"), "findOne").mockRejectedValueOnce(new Error("db down"));
      const response = await app.inject({
        method: "POST",
        url: "/auth/signin",
        payload: { email: testUser.email, password: testUser.password },
      });
      expect(response.statusCode).toBe(500);
    });
  });

  describe("authenticated flows", () => {
    let tokenCookie: string;

    beforeEach(async () => {
      await app.inject({ method: "POST", url: "/auth/signup", payload: testUser });
      const signin = await app.inject({
        method: "POST",
        url: "/auth/signin",
        payload: { email: testUser.email, password: testUser.password },
      });
      const setCookie = signin.headers["set-cookie"];
      tokenCookie = Array.isArray(setCookie) ? setCookie.join("; ") : (setCookie as string);
    });

    it("GET /auth/me returns the current user when authenticated", async () => {
      const response = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: tokenCookie } });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).email).toBe(testUser.email);
    });

    it("GET /auth/me returns 401 without a token", async () => {
      const response = await app.inject({ method: "GET", url: "/auth/me" });
      expect(response.statusCode).toBe(401);
    });

    it("GET /auth/me returns 401 and clears the cookie when the user no longer exists", async () => {
      await getFakeDb().collection("users").deleteOne({ email: testUser.email });
      const response = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: tokenCookie } });
      expect(response.statusCode).toBe(401);
      expect(response.headers["set-cookie"]).toBeDefined();
    });

    it("GET /auth/me returns 500 on an unexpected error", async () => {
      vi.spyOn(getFakeDb().collection("users"), "findOne").mockRejectedValueOnce(new Error("db down"));
      const response = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: tokenCookie } });
      expect(response.statusCode).toBe(500);
    });

    it("GET /auth/sessions lists the active session", async () => {
      const response = await app.inject({ method: "GET", url: "/auth/sessions", headers: { cookie: tokenCookie } });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].isCurrent).toBe(true);
    });

    it("DELETE /auth/sessions/:familyId revokes that session", async () => {
      const list = await app.inject({ method: "GET", url: "/auth/sessions", headers: { cookie: tokenCookie } });
      const { familyId } = JSON.parse(list.payload).sessions[0];

      const response = await app.inject({
        method: "DELETE",
        url: `/auth/sessions/${familyId}`,
        headers: { cookie: tokenCookie },
      });
      expect(response.statusCode).toBe(200);

      const response404 = await app.inject({
        method: "DELETE",
        url: `/auth/sessions/${familyId}`,
        headers: { cookie: tokenCookie },
      });
      expect(response404.statusCode).toBe(404);
    });

    it("POST /auth/logout-all revokes every session and denylists the current access token", async () => {
      const response = await app.inject({ method: "POST", url: "/auth/logout-all", headers: { cookie: tokenCookie } });
      expect(response.statusCode).toBe(200);

      // The very token used to call logout-all is immediately denylisted too.
      const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: tokenCookie } });
      expect(me.statusCode).toBe(401);
    });

    it("POST /auth/signout clears cookies", async () => {
      const response = await app.inject({ method: "POST", url: "/auth/signout", headers: { cookie: tokenCookie } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toBeDefined();
    });
  });

  describe("POST /auth/refresh", () => {
    it("rotates the refresh token and issues a new access token", async () => {
      await app.inject({ method: "POST", url: "/auth/signup", payload: testUser });
      const signin = await app.inject({
        method: "POST",
        url: "/auth/signin",
        payload: { email: testUser.email, password: testUser.password },
      });
      const { refreshToken } = JSON.parse(signin.payload);

      const response = await app.inject({
        method: "POST",
        url: "/auth/refresh",
        payload: { refreshToken },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.accessToken).toBeTruthy();
      expect(body.refreshToken).not.toBe(refreshToken);
    });

    it("revokes the whole family and returns 401 on refresh-token reuse", async () => {
      await app.inject({ method: "POST", url: "/auth/signup", payload: testUser });
      const signin = await app.inject({
        method: "POST",
        url: "/auth/signin",
        payload: { email: testUser.email, password: testUser.password },
      });
      const { refreshToken } = JSON.parse(signin.payload);

      // First use rotates it away.
      await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
      // Reusing the now-superseded token must be treated as theft.
      const reuse = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });

      expect(reuse.statusCode).toBe(401);
      expect(JSON.parse(reuse.payload).message).toContain("Security alert");
    });

    it("fully revokes the family on reuse — the legitimately-rotated token also stops working", async () => {
      await app.inject({ method: "POST", url: "/auth/signup", payload: testUser });
      const signin = await app.inject({
        method: "POST",
        url: "/auth/signin",
        payload: { email: testUser.email, password: testUser.password },
      });
      const { refreshToken: token0 } = JSON.parse(signin.payload);

      const firstRotation = await app.inject({
        method: "POST",
        url: "/auth/refresh",
        payload: { refreshToken: token0 },
      });
      const { refreshToken: token1 } = JSON.parse(firstRotation.payload);

      // Reusing the superseded token0 triggers theft detection and revokes the entire family...
      await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: token0 } });

      // ...so token1, though never itself reused, must also be dead now — the
      // whole family is burned, not just the specific reused token.
      const afterRevocation = await app.inject({
        method: "POST",
        url: "/auth/refresh",
        payload: { refreshToken: token1 },
      });
      expect(afterRevocation.statusCode).toBe(401);
    });

    it("returns 401 when no refresh token is presented", async () => {
      const response = await app.inject({ method: "POST", url: "/auth/refresh", payload: {} });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("POST /auth/forgot-password + /auth/reset-password", () => {
    it("resets the password with the token issued via the dev-mode log line", async () => {
      await app.inject({ method: "POST", url: "/auth/signup", payload: testUser });

      const debugSpy = vi.spyOn(logger, "debug");

      const forgot = await app.inject({
        method: "POST",
        url: "/auth/forgot-password",
        payload: { email: testUser.email },
      });
      expect(forgot.statusCode).toBe(200);
      expect(JSON.parse(forgot.payload).message).toContain("sent");

      const calls = debugSpy.mock.calls as unknown as Array<[Record<string, unknown>, string]>;
      const call = calls.find((c) => c[1]?.includes("[DEV] Password reset token"));
      expect(call).toBeDefined();
      const resetToken = call![0].resetToken as string;
      expect(resetToken).toBeTruthy();

      const reset = await app.inject({
        method: "POST",
        url: "/auth/reset-password",
        payload: { token: resetToken, newPassword: "newpassword123" },
      });
      expect(reset.statusCode).toBe(200);
      expect(JSON.parse(reset.payload).message).toBe("Password has been successfully reset");

      const relogin = await app.inject({
        method: "POST",
        url: "/auth/signin",
        payload: { email: testUser.email, password: "newpassword123" },
      });
      expect(relogin.statusCode).toBe(200);
    });

    it("responds identically for an unknown email (no enumeration)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/forgot-password",
        payload: { email: "unknown@example.com" },
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).message).toContain("If that email exists");
    });

    it("rejects an invalid/expired reset token with 400", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/reset-password",
        payload: { token: "not-a-real-token", newPassword: "somepassword123" },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  it("exposes the fake db for direct inspection when needed", () => {
    expect(getFakeDb()).toBeDefined();
  });
});
