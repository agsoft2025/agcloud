import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { resetFakes, getFakeDb, getFakeRedis } from "../../helpers/mockDb.js";
import { initRealtime, getIO, emitToUser, isUserOnline } from "../../../src/modules/realtime/realtime.service.js";
import { mintAccessToken, makeCallDoc } from "../../helpers/fixtures.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeFakeSocket(overrides: Record<string, unknown> = {}): any {
  return {
    id: "socket-1",
    handshake: { headers: {}, auth: {} },
    data: {},
    join: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("realtime.service", () => {
  let capturedRateLimitMiddleware: (socket: any, next: (err?: Error) => void) => void;
  let capturedAuthMiddleware: (socket: any, next: (err?: Error) => void) => void;
  let capturedConnectionHandler: (socket: any) => void;

  beforeEach(async () => {
    resetFakes();
    // presence.service._setupSubscriber() calls getRedisClient().duplicate().on/.subscribe,
    // which the shared FakeRedis does not implement (duplicate() just returns `this`).
    // Scope a local stub for just this test file rather than editing the shared fake.
    vi.spyOn(getFakeRedis(), "duplicate").mockReturnValue({
      on: vi.fn(),
      subscribe: vi.fn((_channel: string, cb?: (err: Error | null) => void) => cb?.(null)),
    } as any);

    const useSpy = vi.spyOn(SocketIOServer.prototype, "use");
    // Namespace.emit() is overridden to broadcast to real connected clients rather
    // than invoke local "on" listeners, so `io.emit("connection", ...)` can't be
    // used to trigger the handler — capture it directly from the `.on()` call instead.
    const onSpy = vi.spyOn(SocketIOServer.prototype, "on");

    const httpServer = http.createServer();
    initRealtime(httpServer);

    // io.use() is registered twice: [0] the per-IP connect rate limiter (runs
    // first, before auth), [1] the JWT auth middleware.
    capturedRateLimitMiddleware = useSpy.mock.calls[0][0] as typeof capturedRateLimitMiddleware;
    capturedAuthMiddleware = useSpy.mock.calls[1][0] as typeof capturedAuthMiddleware;
    capturedConnectionHandler = onSpy.mock.calls.find((c) => c[0] === "connection")?.[1] as typeof capturedConnectionHandler;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("connect rate limit middleware", () => {
    it("allows a connection under the per-IP threshold", async () => {
      const socket = makeFakeSocket({ handshake: { headers: {}, auth: {}, address: "1.2.3.4" } });
      const next = vi.fn();

      capturedRateLimitMiddleware(socket, next);
      await flushMicrotasks();

      expect(next).toHaveBeenCalledWith();
    });

    it("rejects a connection once the per-IP threshold is exceeded", async () => {
      const ip = "9.9.9.9";
      // Pre-fill the Redis counter past the limit (30/min) as if 30 prior connects already happened.
      await getFakeRedis().set(`ratelimit:socket:connect:${ip}`, "30");

      const socket = makeFakeSocket({ handshake: { headers: {}, auth: {}, address: ip } });
      const next = vi.fn();

      capturedRateLimitMiddleware(socket, next);
      await flushMicrotasks();

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it("prefers x-forwarded-for over the raw socket address", async () => {
      const ip = "5.5.5.5";
      await getFakeRedis().set(`ratelimit:socket:connect:${ip}`, "30");

      const socket = makeFakeSocket({
        handshake: { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` }, auth: {}, address: "10.0.0.1" },
      });
      const next = vi.fn();

      capturedRateLimitMiddleware(socket, next);
      await flushMicrotasks();

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it("fails open when the Redis check throws", async () => {
      vi.spyOn(getFakeRedis(), "incr").mockRejectedValueOnce(new Error("redis down"));
      const socket = makeFakeSocket({ handshake: { headers: {}, auth: {}, address: "8.8.8.8" } });
      const next = vi.fn();

      capturedRateLimitMiddleware(socket, next);
      await flushMicrotasks();

      expect(next).toHaveBeenCalledWith();
    });
  });

  describe("auth middleware", () => {
    it("authenticates via socket.handshake.auth.token", () => {
      const token = mintAccessToken("user-1", "user1@example.com");
      const socket = makeFakeSocket({ handshake: { headers: {}, auth: { token } } });
      const next = vi.fn();

      capturedAuthMiddleware(socket, next);

      expect(next).toHaveBeenCalledWith();
      expect(socket.data.userId).toBe("user-1");
    });

    it("authenticates via the Authorization header", () => {
      const token = mintAccessToken("user-2", "user2@example.com");
      const socket = makeFakeSocket({ handshake: { headers: { authorization: `Bearer ${token}` }, auth: {} } });
      const next = vi.fn();

      capturedAuthMiddleware(socket, next);

      expect(next).toHaveBeenCalledWith();
      expect(socket.data.userId).toBe("user-2");
    });

    it("authenticates via a cookie", () => {
      const token = mintAccessToken("user-3", "user3@example.com");
      const socket = makeFakeSocket({ handshake: { headers: { cookie: `token=${token}` }, auth: {} } });
      const next = vi.fn();

      capturedAuthMiddleware(socket, next);

      expect(next).toHaveBeenCalledWith();
      expect(socket.data.userId).toBe("user-3");
    });

    it("rejects a connection with no token", () => {
      const socket = makeFakeSocket();
      const next = vi.fn();

      capturedAuthMiddleware(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it("rejects a connection with an invalid token", () => {
      const socket = makeFakeSocket({ handshake: { headers: {}, auth: { token: "not-a-valid-jwt" } } });
      const next = vi.fn();

      capturedAuthMiddleware(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe("connection handling", () => {
    it("joins the per-user room and registers PING/disconnect handlers", async () => {
      const socket = makeFakeSocket({ data: { userId: "user-4" } });

      capturedConnectionHandler(socket);
      await flush();

      expect(socket.join).toHaveBeenCalledWith("user:user-4");
      expect(socket.on).toHaveBeenCalledWith("PING", expect.any(Function));
      expect(socket.on).toHaveBeenCalledWith("disconnect", expect.any(Function));
    });

    it("throttles PING responses faster than the minimum interval", async () => {
      const socket = makeFakeSocket({ data: { userId: "user-throttle" } });

      capturedConnectionHandler(socket);
      await flush();

      const pingHandler = socket.on.mock.calls.find((c: unknown[]) => c[0] === "PING")?.[1] as () => void;
      expect(pingHandler).toBeInstanceOf(Function);

      pingHandler();
      pingHandler(); // fired immediately after — should be dropped by the throttle
      await flush();

      const pongEmits = socket.emit.mock.calls.filter((c: unknown[]) => c[0] === "PONG");
      expect(pongEmits).toHaveLength(1);
    });

    it("re-invites pending calls for the connecting user", async () => {
      const call = makeCallDoc({
        receiverIds: ["user-5"],
        status: "initiated",
        participants: { "user-5": { status: "invited", invitedAt: new Date(), invitedBy: "caller-1" } },
      });
      await getFakeDb().collection("calls").insertOne(call as any);

      const io = getIO()!;
      const toSpy = vi.spyOn(io, "to");
      const socket = makeFakeSocket({ data: { userId: "user-5" } });

      capturedConnectionHandler(socket);
      await flush();

      expect(toSpy).toHaveBeenCalledWith("user:user-5");
    });
  });

  describe("emitToUser", () => {
    it("emits to the user's room", () => {
      const io = getIO()!;
      const toSpy = vi.spyOn(io, "to");

      emitToUser("user-6", "some:event", { foo: 1 });

      expect(toSpy).toHaveBeenCalledWith("user:user-6");
    });
  });

  describe("isUserOnline", () => {
    it("is deprecated and always returns false", () => {
      expect(isUserOnline("anyone")).toBe(false);
    });
  });
});
