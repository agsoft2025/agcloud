import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { connectMongo } from "../src/shared/db/mongo.client.js";

describe("Auth Routes", () => {
  let app: FastifyInstance;
  let db: any;
  let resetToken = "";

  const testUser = {
    email: `test-${Date.now()}@example.com`,
    password: "password123",
    displayName: "Test User"
  };

  beforeAll(async () => {
    // Suppress logs during tests
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "a_very_long_and_secure_secret_for_tests_32_chars_plus";
    app = await buildApp();
    db = await connectMongo();
  });

  afterAll(async () => {
    await app.close();
    // Cleanup the test user
    await db.collection("users").deleteOne({ email: testUser.email });
  });

  describe("POST /auth/signup", () => {
    it("should register a new user", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/signup",
        payload: testUser
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe("User registered successfully");
      expect(body.user.email).toBe(testUser.email);
    });

    it("should not register a duplicate user", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/signup",
        payload: testUser
      });

      expect(response.statusCode).toBe(409);
    });
  });

  let tokenCookie = "";

  describe("POST /auth/signin", () => {
    it("should login an existing user", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/signin",
        payload: {
          email: testUser.email,
          password: testUser.password
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe("Login successful");
      expect(body.user.email).toBe(testUser.email);
      
      // Save cookie for next test
      tokenCookie = response.headers["set-cookie"] as string;
      if (Array.isArray(tokenCookie)) {
        tokenCookie = tokenCookie[0];
      }
    });

    it("should fail with incorrect password", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/signin",
        payload: {
          email: testUser.email,
          password: "wrongpassword"
        }
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("POST /auth/signout", () => {
    it("should clear the token cookie", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/signout",
        headers: {
          cookie: tokenCookie
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toBeDefined();
    });
  });

  describe("POST /auth/forgot-password", () => {
    it("should successfully send reset link", async () => {
      // We will spy on console.log to get the raw token emitted in dev
      const logSpy = vi.spyOn(console, "log");

      const response = await app.inject({
        method: "POST",
        url: "/auth/forgot-password",
        payload: { email: testUser.email }
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).message).toContain("sent");

      // Extract the token from console.log output (only available because we printed it)
      const logCall = logSpy.mock.calls.find(call => call[0] && typeof call[0] === 'string' && call[0].includes("Reset token for"));
      if (logCall) {
        resetToken = logCall[0].split(": ")[1];
      }
      
      logSpy.mockRestore();
    });
  });

  describe("POST /auth/reset-password", () => {
    it("should reset password with valid token", async () => {
      expect(resetToken).not.toBe(""); // Ensure forgot-password successfully captured the token

      const response = await app.inject({
        method: "POST",
        url: "/auth/reset-password",
        payload: {
          token: resetToken,
          newPassword: "newpassword123"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).message).toBe("Password has been successfully reset");
    });

    it("should now login with new password", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/signin",
        payload: {
          email: testUser.email,
          password: "newpassword123"
        }
      });

      expect(response.statusCode).toBe(200);
    });
  });
});
