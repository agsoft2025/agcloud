import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../../helpers/buildTestApp.js";
import { getFakeDb, getFakeRedis, resetFakes } from "../../helpers/mockDb.js";
import { livekitMocks } from "../../helpers/mockLivekit.js";

describe("health routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetFakes();
    livekitMocks.listRooms.mockResolvedValue([]);
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("GET /live returns ok", async () => {
    const response = await app.inject({ method: "GET", url: "/live" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ status: "ok", type: "liveness" });
  });

  it("GET /ready returns 200 when all dependencies are healthy", async () => {
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.status).toBe("ok");
    expect(body.details).toEqual({ mongodb: true, redis: true, livekit: true });
  });

  it("GET /ready returns 503 when redis is down", async () => {
    const redis = getFakeRedis();
    vi.spyOn(redis, "ping").mockRejectedValueOnce(new Error("connection refused"));

    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.payload);
    expect(body.status).toBe("unhealthy");
    expect(body.details.redis).toBe(false);
  });

  it("GET /ready returns 503 when mongodb is down", async () => {
    vi.spyOn(getFakeDb(), "command").mockRejectedValueOnce(new Error("mongo unreachable"));

    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.payload).details.mongodb).toBe(false);
  });

  it("GET /ready returns 503 when livekit is down", async () => {
    livekitMocks.listRooms.mockRejectedValueOnce(new Error("livekit unreachable"));

    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.payload).details.livekit).toBe(false);
  });

  it("GET /metrics returns Prometheus-formatted metrics", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBeTruthy();
    expect(typeof response.payload).toBe("string");
  });

  it("GET / returns the HTML dashboard", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.payload).toContain("agcloud API is Online");
  });
});
