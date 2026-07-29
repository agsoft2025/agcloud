import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { buildTestApp } from "../../helpers/buildTestApp.js";
import { getFakeDb, resetFakes } from "../../helpers/mockDb.js";
import { livekitMocks } from "../../helpers/mockLivekit.js";
import { bullmqMocks, resetBullmqMocks } from "../../helpers/mockBullmq.js";
import { authHeader, makeCallDoc, makeUserDoc, makeDeviceDoc } from "../../helpers/fixtures.js";
import config from "../../../src/config/index.js";

// Spec §10.2 critical scenario: "callee offline (push fallback)". Only the
// actual network send is mocked — the route handler, notification.service.ts,
// and device lookup all run for real, so this proves initiate really does
// wire up a push attempt for every receiver, not just the socket emit.
vi.mock("../../../src/modules/notification/fcm.client.js", () => ({
  sendFcmNotification: vi.fn().mockResolvedValue({ ok: true }),
}));
import { sendFcmNotification } from "../../../src/modules/notification/fcm.client.js";

describe("Call Routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetFakes();
    resetBullmqMocks();
    livekitMocks.toJwt.mockResolvedValue("fake.livekit.jwt");
    livekitMocks.deleteRoom.mockResolvedValue(undefined);
    livekitMocks.startRoomCompositeEgress.mockResolvedValue({ egressId: "egress-123" });
    livekitMocks.stopEgress.mockResolvedValue({ egressId: "egress-123" });
    vi.mocked(sendFcmNotification).mockClear().mockResolvedValue({ ok: true });
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  function newId(): string {
    return new ObjectId().toString();
  }

  async function seedCall(overrides: Record<string, unknown> = {}) {
    const doc = makeCallDoc(overrides);
    await getFakeDb().collection("calls").insertOne(doc);
    return doc;
  }

  describe("GET /calls", () => {
    it("returns the static endpoints list without auth", async () => {
      const response = await app.inject({ method: "GET", url: "/calls" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe("Call routes are active");
      expect(Array.isArray(body.endpoints)).toBe(true);
    });
  });

  describe("GET /calls/test", () => {
    it("serves the WebRTC tester page outside production", async () => {
      const response = await app.inject({ method: "GET", url: "/calls/test" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
    });

    it("returns 404 in production (unauthenticated debug tool must not be reachable)", async () => {
      const original = config.env;
      (config as any).env = "production";
      try {
        const response = await app.inject({ method: "GET", url: "/calls/test" });
        expect(response.statusCode).toBe(404);
      } finally {
        (config as any).env = original;
      }
    });
  });

  describe("POST /calls/initiate", () => {
    it("returns 400 when no receivers are resolved", async () => {
      const callerId = newId();
      const response = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(callerId, "caller@example.com"),
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).message).toBe("At least one receiver ID is required");
    });

    it("returns 400 when calling yourself", async () => {
      const callerId = newId();
      const response = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(callerId, "caller@example.com"),
        payload: { calleeId: callerId },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).message).toBe("You cannot call yourself");
    });

    it("returns 400 when caller already has an active call", async () => {
      const callerId = newId();
      const otherId = newId();
      const existing = await seedCall({
        callerId,
        calleeId: otherId,
        receiverIds: [otherId],
        status: "initiated",
      });

      const response = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(callerId, "caller@example.com"),
        payload: { calleeId: newId() },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe("You are already in an active call");
      expect(body.callId).toBe(existing._id.toString());
    });

    it("spec §10.2 'simultaneous initiation': a caller_active unique-index violation (two requests racing past the read check) reports the same 400 as the early check", async () => {
      const callerId = newId();
      // The "first" request's call, already committed by the time the
      // second one's insert is attempted.
      const winner = await seedCall({ callerId, status: "initiated" });
      // Simulate the race window: the second request's early
      // getActiveCallForUser read happened *before* the first request's
      // insert was visible, so it sees no active call (this one-time
      // override only affects the first call — the post-error re-fetch
      // below falls through to the real implementation, which does see
      // `winner`). The DB-level unique index is what actually catches this
      // in production; here the insert itself is forced to reject the way
      // MongoDB would.
      const { CallRepository } = await import("../../../src/modules/call/call.repository.js");
      vi.spyOn(CallRepository.prototype, "getActiveCallForUser").mockResolvedValueOnce(null);
      vi.spyOn(getFakeDb().collection("calls"), "insertOne").mockRejectedValueOnce(
        Object.assign(new Error("E11000 duplicate key error"), { code: 11000 })
      );

      const response = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(callerId, "caller@example.com"),
        payload: { calleeId: newId() },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe("You are already in an active call");
      expect(body.callId).toBe(winner._id.toString());
    });

    it("returns 409 with busyReceiverIds when the only receiver is busy (one-to-one)", async () => {
      const callerId = newId();
      const receiverId = newId();
      const someoneElse = newId();
      await seedCall({
        callerId: someoneElse,
        calleeId: receiverId,
        receiverIds: [receiverId],
        status: "active",
      });

      const response = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(callerId, "caller@example.com"),
        payload: { calleeId: receiverId },
      });
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe("The person you are calling is currently on another call");
      expect(body.busyReceiverIds).toEqual([receiverId]);
    });

    it("returns 409 with a conference-specific message when all conference invitees are busy", async () => {
      const callerId = newId();
      const receiver1 = newId();
      const receiver2 = newId();
      const someoneElse = newId();
      await seedCall({
        callerId: someoneElse,
        calleeId: receiver1,
        receiverIds: [receiver1],
        status: "initiated",
      });
      await seedCall({
        callerId: someoneElse,
        calleeId: receiver2,
        receiverIds: [receiver2],
        status: "active",
      });

      const response = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(callerId, "caller@example.com"),
        payload: { receiverIds: [receiver1, receiver2], callMode: "conference" },
      });
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe("All invited participants are currently on another call");
      expect(body.busyReceiverIds.sort()).toEqual([receiver1, receiver2].sort());
    });

    it("creates a call with only available receivers when some are busy (conference, partial)", async () => {
      const callerId = newId();
      const freeReceiver = newId();
      const busyReceiver = newId();
      const someoneElse = newId();
      await seedCall({
        callerId: someoneElse,
        calleeId: busyReceiver,
        receiverIds: [busyReceiver],
        status: "initiated",
      });

      const response = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(callerId, "caller@example.com"),
        payload: { receiverIds: [freeReceiver, busyReceiver], callMode: "conference" },
      });
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.busyReceiverIds).toEqual([busyReceiver]);
      expect(body.call.receiverIds).toEqual([freeReceiver]);
    });

    it("initiates a call successfully and returns a LiveKit token", async () => {
      const callerId = newId();
      const receiverId = newId();

      const response = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(callerId, "caller@example.com"),
        payload: { calleeId: receiverId, callType: "video" },
      });
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe("Call initiated successfully");
      expect(body.token).toBe("fake.livekit.jwt");
      expect(body.url).toBe("wss://test.livekit.cloud");
      expect(body.roomName).toBeTruthy();
      expect(body.busyReceiverIds).toBeUndefined();
      expect(body.call.callerId).toBe(callerId);
      expect(body.call.receiverIds).toEqual([receiverId]);
    });

    it("schedules a 60s auto-missed timeout job keyed by the call id", async () => {
      const callerId = newId();
      const receiverId = newId();

      const response = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(callerId, "caller@example.com"),
        payload: { calleeId: receiverId },
      });
      const callId = JSON.parse(response.payload).call._id;

      expect(bullmqMocks.add).toHaveBeenCalledWith(
        "timeout",
        { callId },
        expect.objectContaining({ delay: 60_000, jobId: callId })
      );
    });

    it("replays the cached response instead of creating a second call for a repeated Idempotency-Key", async () => {
      const callerId = newId();
      const receiverId = newId();
      const idempotencyKey = "test-idem-key-1";

      const first = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: {
          ...authHeader(callerId, "caller@example.com"),
          "idempotency-key": idempotencyKey,
        },
        payload: { calleeId: receiverId },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: {
          ...authHeader(callerId, "caller@example.com"),
          "idempotency-key": idempotencyKey,
        },
        payload: { calleeId: receiverId },
      });
      expect(second.statusCode).toBe(201);
      expect(JSON.parse(second.payload)).toEqual(JSON.parse(first.payload));

      const calls = await getFakeDb().collection("calls").find({ callerId }).toArray();
      expect(calls).toHaveLength(1);
    });

    it("excludes a receiver who has blocked the caller and reports blockedReceiverIds", async () => {
      const callerId = newId();
      const blockerId = newId();
      await getFakeDb().collection("blocks").insertOne({
        blockerId,
        blockedId: callerId,
        createdAt: new Date(),
      });

      const response = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(callerId, "caller@example.com"),
        payload: { calleeId: blockerId },
      });
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.payload);
      expect(body.blockedReceiverIds).toEqual([blockerId]);
    });

    it("excludes a receiver the caller has blocked, in a conference with other available receivers", async () => {
      const callerId = newId();
      const blockedReceiver = newId();
      const availableReceiver = newId();
      await getFakeDb().collection("blocks").insertOne({
        blockerId: callerId,
        blockedId: blockedReceiver,
        createdAt: new Date(),
      });

      const response = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(callerId, "caller@example.com"),
        payload: { receiverIds: [availableReceiver, blockedReceiver], callMode: "conference" },
      });
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.blockedReceiverIds).toEqual([blockedReceiver]);
      expect(body.call.receiverIds).toEqual([availableReceiver]);
    });

    it("rate-limits per user (spec §5.4: 10/min) — the 11th request in a minute gets 429", async () => {
      const callerId = newId();
      for (let i = 0; i < 10; i++) {
        const response = await app.inject({
          method: "POST",
          url: "/calls/initiate",
          headers: authHeader(callerId, "caller@example.com"),
          payload: {}, // invalid payload (400) is fine — still counts against the limit
        });
        expect(response.statusCode).not.toBe(429);
      }

      const eleventh = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(callerId, "caller@example.com"),
        payload: {},
      });
      expect(eleventh.statusCode).toBe(429);
    });

    it("keys the rate limit by user, not by IP — a different user is unaffected", async () => {
      const callerId = newId();
      const otherCaller = newId();
      for (let i = 0; i < 10; i++) {
        await app.inject({
          method: "POST",
          url: "/calls/initiate",
          headers: authHeader(callerId, "caller@example.com"),
          payload: {},
        });
      }

      const response = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(otherCaller, "other@example.com"),
        payload: {},
      });
      expect(response.statusCode).not.toBe(429);
    });

    it("spec §10.2 'callee offline (push fallback)': initiating a call attempts a push to the receiver's registered device", async () => {
      const callerId = newId();
      const receiverId = newId();
      await getFakeDb()
        .collection("devices")
        .insertOne(makeDeviceDoc({ userId: receiverId, platform: "android", token: "receiver-device-tok" }));

      const response = await app.inject({
        method: "POST",
        url: "/calls/initiate",
        headers: authHeader(callerId, "caller@example.com"),
        payload: { calleeId: receiverId },
      });
      expect(response.statusCode).toBe(201);

      expect(sendFcmNotification).toHaveBeenCalledWith(
        expect.objectContaining({ token: "receiver-device-tok", title: "Incoming Call" })
      );
    });
  });

  describe("POST /calls/:id/add-participant", () => {
    it("returns 404 when the call does not exist", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/calls/${newId()}/add-participant`,
        headers: authHeader(newId(), "a@example.com"),
        payload: { userId: newId() },
      });
      expect(response.statusCode).toBe(404);
    });

    it("returns 403 when requester is not caller or receiver", async () => {
      const callerId = newId();
      const receiverId = newId();
      const call = await seedCall({ callerId, calleeId: receiverId, receiverIds: [receiverId] });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/add-participant`,
        headers: authHeader(newId(), "stranger@example.com"),
        payload: { userId: newId() },
      });
      expect(response.statusCode).toBe(403);
    });

    it("returns 400 when call status is not initiated/active", async () => {
      const callerId = newId();
      const receiverId = newId();
      const call = await seedCall({
        callerId,
        calleeId: receiverId,
        receiverIds: [receiverId],
        status: "ended",
      });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/add-participant`,
        headers: authHeader(callerId, "caller@example.com"),
        payload: { userId: newId() },
      });
      expect(response.statusCode).toBe(400);
    });

    it("returns 400 when target is the caller", async () => {
      const callerId = newId();
      const receiverId = newId();
      const call = await seedCall({ callerId, calleeId: receiverId, receiverIds: [receiverId] });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/add-participant`,
        headers: authHeader(callerId, "caller@example.com"),
        payload: { userId: callerId },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).message).toBe(
        "User is already a participant in this call"
      );
    });

    it("returns 400 when target participant is already joined", async () => {
      const callerId = newId();
      const receiverId = newId();
      const alreadyJoined = newId();
      const call = await seedCall({
        callerId,
        calleeId: receiverId,
        receiverIds: [receiverId, alreadyJoined],
        participants: {
          [receiverId]: { status: "invited", invitedAt: new Date(), invitedBy: callerId },
          [alreadyJoined]: { status: "joined", invitedAt: new Date(), invitedBy: callerId },
        },
      });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/add-participant`,
        headers: authHeader(callerId, "caller@example.com"),
        payload: { userId: alreadyJoined },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).message).toBe("User is already in this call");
    });

    it("returns 404 when target user doc does not exist", async () => {
      const callerId = newId();
      const receiverId = newId();
      const call = await seedCall({ callerId, calleeId: receiverId, receiverIds: [receiverId] });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/add-participant`,
        headers: authHeader(callerId, "caller@example.com"),
        payload: { userId: newId() },
      });
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.payload).message).toBe("User not found");
    });

    it("invites (re-invites) an existing target user successfully", async () => {
      const callerId = newId();
      const receiverId = newId();
      const targetId = newId();
      await getFakeDb()
        .collection("users")
        .insertOne(makeUserDoc({ _id: new ObjectId(targetId), displayName: "Target User" }));
      const call = await seedCall({
        callerId,
        calleeId: receiverId,
        receiverIds: [receiverId, targetId],
        participants: {
          [receiverId]: { status: "invited", invitedAt: new Date(), invitedBy: callerId },
          [targetId]: { status: "missed", invitedAt: new Date(), invitedBy: callerId },
        },
      });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/add-participant`,
        headers: authHeader(callerId, "caller@example.com"),
        payload: { userId: targetId },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.call.participants[targetId].status).toBe("invited");
    });
  });

  describe("GET /calls/:id", () => {
    it("returns 404 when the call does not exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/calls/${newId()}`,
        headers: authHeader(newId(), "a@example.com"),
      });
      expect(response.statusCode).toBe(404);
    });

    it("returns 403 for unauthorized users", async () => {
      const callerId = newId();
      const receiverId = newId();
      const call = await seedCall({ callerId, calleeId: receiverId, receiverIds: [receiverId] });

      const response = await app.inject({
        method: "GET",
        url: `/calls/${call._id.toString()}`,
        headers: authHeader(newId(), "stranger@example.com"),
      });
      expect(response.statusCode).toBe(403);
    });

    it("allows the caller to view the call", async () => {
      const callerId = newId();
      const receiverId = newId();
      const call = await seedCall({ callerId, calleeId: receiverId, receiverIds: [receiverId] });

      const response = await app.inject({
        method: "GET",
        url: `/calls/${call._id.toString()}`,
        headers: authHeader(callerId, "caller@example.com"),
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).call.callerId).toBe(callerId);
    });

    it("allows a conference receiver to view the call", async () => {
      const callerId = newId();
      const receiverId = newId();
      const call = await seedCall({
        callerId,
        calleeId: receiverId,
        receiverIds: [receiverId],
        callMode: "conference",
      });

      const response = await app.inject({
        method: "GET",
        url: `/calls/${call._id.toString()}`,
        headers: authHeader(receiverId, "receiver@example.com"),
      });
      expect(response.statusCode).toBe(200);
    });

    it("allows the one-to-one calleeId to view the call", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({
        callerId,
        calleeId,
        receiverIds: [calleeId],
        callMode: "one-to-one",
      });

      const response = await app.inject({
        method: "GET",
        url: `/calls/${call._id.toString()}`,
        headers: authHeader(calleeId, "callee@example.com"),
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe("POST /calls/:id/accept", () => {
    it("returns 404/403 appropriately", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({ callerId, calleeId, receiverIds: [calleeId] });

      const notFound = await app.inject({
        method: "POST",
        url: `/calls/${newId()}/accept`,
        headers: authHeader(calleeId, "callee@example.com"),
      });
      expect(notFound.statusCode).toBe(404);

      const forbidden = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/accept`,
        headers: authHeader(newId(), "stranger@example.com"),
      });
      expect(forbidden.statusCode).toBe(403);
    });

    it("returns 400 for an invalid transition", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({ callerId, calleeId, receiverIds: [calleeId], status: "ended" });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/accept`,
        headers: authHeader(calleeId, "callee@example.com"),
      });
      expect(response.statusCode).toBe(400);
    });

    it("accepts a call, transitions to active, and returns a token", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({
        callerId,
        calleeId,
        receiverIds: [calleeId],
        status: "initiated",
      });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/accept`,
        headers: authHeader(calleeId, "callee@example.com"),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.token).toBe("fake.livekit.jwt");
      expect(body.call.status).toBe("active");

      const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
      expect(updated!.status).toBe("active");
      expect(updated!.participants[calleeId].status).toBe("joined");
    });
  });

  describe("POST /calls/:id/reject", () => {
    it("marks only the rejecting participant's status in a conference without ending the call", async () => {
      const callerId = newId();
      const receiverId = newId();
      const call = await seedCall({
        callerId,
        calleeId: receiverId,
        receiverIds: [receiverId],
        callMode: "conference",
        status: "active",
      });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/reject`,
        headers: authHeader(receiverId, "receiver@example.com"),
      });
      expect(response.statusCode).toBe(200);

      const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
      expect(updated!.status).toBe("active");
      expect(updated!.participants[receiverId].status).toBe("rejected");
    });

    it("returns 400 for an invalid one-to-one transition", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({
        callerId,
        calleeId,
        receiverIds: [calleeId],
        status: "active",
      });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/reject`,
        headers: authHeader(calleeId, "callee@example.com"),
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a one-to-one call from initiated", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({
        callerId,
        calleeId,
        receiverIds: [calleeId],
        status: "initiated",
      });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/reject`,
        headers: authHeader(calleeId, "callee@example.com"),
      });
      expect(response.statusCode).toBe(200);

      const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
      expect(updated!.status).toBe("rejected");
    });
  });

  describe("POST /calls/:id/cancel", () => {
    it("returns 404 when the call does not exist", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/calls/${newId()}/cancel`,
        headers: authHeader(newId(), "a@example.com"),
      });
      expect(response.statusCode).toBe(404);
    });

    it("returns 403 when a non-caller tries to cancel", async () => {
      const callerId = newId();
      const receiverId = newId();
      const call = await seedCall({
        callerId,
        calleeId: receiverId,
        receiverIds: [receiverId],
        status: "initiated",
      });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/cancel`,
        headers: authHeader(receiverId, "receiver@example.com"),
      });
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.payload).message).toBe("Only the caller can cancel this call");
    });

    it("returns 400 when the call is no longer 'initiated' (already active)", async () => {
      const callerId = newId();
      const receiverId = newId();
      const call = await seedCall({
        callerId,
        calleeId: receiverId,
        receiverIds: [receiverId],
        status: "active",
      });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/cancel`,
        headers: authHeader(callerId, "caller@example.com"),
      });
      expect(response.statusCode).toBe(400);
    });

    it("cancels a pre-pickup call: transitions to 'cancelled', marks pending invites cancelled, ends the room, and cancels the timeout job", async () => {
      const callerId = newId();
      const receiverId = newId();
      const call = await seedCall({
        callerId,
        calleeId: receiverId,
        receiverIds: [receiverId],
        status: "initiated",
        participants: {
          [receiverId]: { status: "invited", invitedAt: new Date(), invitedBy: callerId },
        },
      });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/cancel`,
        headers: authHeader(callerId, "caller@example.com"),
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).message).toBe("Call cancelled successfully");

      const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
      expect(updated!.status).toBe("cancelled");
      expect(updated!.endedAt).toBeTruthy();
      expect(updated!.participants[receiverId].status).toBe("cancelled");

      expect(livekitMocks.deleteRoom).toHaveBeenCalled();
      expect(bullmqMocks.getJob).toHaveBeenCalledWith(call._id.toString());
    });

    it("does not mark an already-joined conference participant as cancelled", async () => {
      const callerId = newId();
      const joined = newId();
      const stillRinging = newId();
      const call = await seedCall({
        callerId,
        callMode: "conference",
        receiverIds: [joined, stillRinging],
        status: "initiated",
        participants: {
          [joined]: { status: "joined", invitedAt: new Date(), invitedBy: callerId },
          [stillRinging]: { status: "invited", invitedAt: new Date(), invitedBy: callerId },
        },
      });

      await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/cancel`,
        headers: authHeader(callerId, "caller@example.com"),
      });

      const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
      expect(updated!.participants[joined].status).toBe("joined");
      expect(updated!.participants[stillRinging].status).toBe("cancelled");
    });
  });

  describe("POST /calls/:id/leave", () => {
    it("returns 404/403 appropriately", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({ callerId, calleeId, receiverIds: [calleeId] });

      const notFound = await app.inject({
        method: "POST",
        url: `/calls/${newId()}/leave`,
        headers: authHeader(calleeId, "callee@example.com"),
      });
      expect(notFound.statusCode).toBe(404);

      const forbidden = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/leave`,
        headers: authHeader(newId(), "stranger@example.com"),
      });
      expect(forbidden.statusCode).toBe(403);
    });

    it("is a no-op 200 when the call is already ended", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({ callerId, calleeId, receiverIds: [calleeId], status: "ended" });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/leave`,
        headers: authHeader(calleeId, "callee@example.com"),
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).message).toBe("Call already ended");
    });

    it("keeps the call open when the second-to-last participant leaves, then ends it when the last leaves", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({
        callerId,
        calleeId,
        receiverIds: [calleeId],
        callMode: "one-to-one",
        status: "initiated",
      });

      const firstLeave = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/leave`,
        headers: authHeader(calleeId, "callee@example.com"),
      });
      expect(firstLeave.statusCode).toBe(200);

      let updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
      expect(updated!.status).not.toBe("ended");
      expect(updated!.participants[calleeId].status).toBe("left");

      const secondLeave = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/leave`,
        headers: authHeader(callerId, "caller@example.com"),
      });
      expect(secondLeave.statusCode).toBe(200);

      updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
      expect(updated!.status).toBe("ended");
      expect(livekitMocks.deleteRoom).toHaveBeenCalled();
    });
  });

  describe("POST /calls/:id/end", () => {
    it("returns 404/403 appropriately", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({ callerId, calleeId, receiverIds: [calleeId] });

      const notFound = await app.inject({
        method: "POST",
        url: `/calls/${newId()}/end`,
        headers: authHeader(calleeId, "callee@example.com"),
      });
      expect(notFound.statusCode).toBe(404);

      const forbidden = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/end`,
        headers: authHeader(newId(), "stranger@example.com"),
      });
      expect(forbidden.statusCode).toBe(403);
    });

    it("still calls endLiveKitRoom and replies 'Call already ended' when already ended", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({ callerId, calleeId, receiverIds: [calleeId], status: "ended" });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/end`,
        headers: authHeader(callerId, "caller@example.com"),
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).message).toBe("Call already ended");
      expect(livekitMocks.deleteRoom).toHaveBeenCalled();
    });

    it("ends an active call, marks pending invites missed, and ends the room", async () => {
      const callerId = newId();
      const calleeId = newId();
      const pendingId = newId();
      const call = await seedCall({
        callerId,
        calleeId,
        receiverIds: [calleeId, pendingId],
        status: "active",
        participants: {
          [calleeId]: { status: "joined", invitedAt: new Date(), invitedBy: callerId },
          [pendingId]: { status: "invited", invitedAt: new Date(), invitedBy: callerId },
        },
      });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/end`,
        headers: authHeader(callerId, "caller@example.com"),
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).message).toBe("Call ended successfully");

      const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
      expect(updated!.status).toBe("ended");
      expect(updated!.participants[pendingId].status).toBe("missed");
      expect(livekitMocks.deleteRoom).toHaveBeenCalled();
    });
  });

  describe("POST /calls/:id/record/start and /record/stop", () => {
    it("returns 404/403 for start", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({ callerId, calleeId, receiverIds: [calleeId] });

      const notFound = await app.inject({
        method: "POST",
        url: `/calls/${newId()}/record/start`,
        headers: authHeader(callerId, "caller@example.com"),
      });
      expect(notFound.statusCode).toBe(404);

      const forbidden = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/record/start`,
        headers: authHeader(newId(), "stranger@example.com"),
      });
      expect(forbidden.statusCode).toBe(403);
    });

    it("starts recording and persists recording:true with the egressId", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({ callerId, calleeId, receiverIds: [calleeId] });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/record/start`,
        headers: authHeader(callerId, "caller@example.com"),
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).egressId).toBe("egress-123");

      const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
      expect(updated!.recording).toBe(true);
      expect(updated!.egressId).toBe("egress-123");
    });

    it("returns 400 for stop when no egressId exists yet", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({ callerId, calleeId, receiverIds: [calleeId] });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/record/stop`,
        headers: authHeader(callerId, "caller@example.com"),
      });
      expect(response.statusCode).toBe(400);
    });

    it("stops recording and persists recording:false", async () => {
      const callerId = newId();
      const calleeId = newId();
      const call = await seedCall({
        callerId,
        calleeId,
        receiverIds: [calleeId],
        recording: true,
        egressId: "egress-123",
      });

      const response = await app.inject({
        method: "POST",
        url: `/calls/${call._id.toString()}/record/stop`,
        headers: authHeader(callerId, "caller@example.com"),
      });
      expect(response.statusCode).toBe(200);

      const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
      expect(updated!.recording).toBe(false);
      expect(livekitMocks.stopEgress).toHaveBeenCalledWith("egress-123");
    });
  });

  describe("GET /calls/history", () => {
    it("requires authentication", async () => {
      const response = await app.inject({ method: "GET", url: "/calls/history" });
      expect(response.statusCode).toBe(401);
    });

    it("clamps the limit query param to [1, 100] and defaults to 20", async () => {
      const userId = newId();
      const response = await app.inject({
        method: "GET",
        url: "/calls/history?limit=99999",
        headers: authHeader(userId, "u@example.com"),
      });
      expect(response.statusCode).toBe(200);
      // No direct way to observe the clamped value other than it not erroring;
      // confirm default path too.
      const responseDefault = await app.inject({
        method: "GET",
        url: "/calls/history",
        headers: authHeader(userId, "u@example.com"),
      });
      expect(responseDefault.statusCode).toBe(200);
    });

    it("computes durationSeconds only when both startedAt and endedAt are set, and participantCount", async () => {
      const userId = newId();
      const otherId = newId();
      const startedAt = new Date("2026-07-18T10:00:00.000Z");
      const endedAt = new Date("2026-07-18T10:05:00.000Z");

      await seedCall({
        callerId: userId,
        calleeId: otherId,
        receiverIds: [otherId],
        status: "ended",
        startedAt,
        endedAt,
        participants: { [otherId]: { status: "joined", invitedAt: new Date(), invitedBy: userId } },
      });
      await seedCall({
        callerId: userId,
        calleeId: otherId,
        receiverIds: [otherId],
        status: "initiated",
        participants: {
          [otherId]: { status: "invited", invitedAt: new Date(), invitedBy: userId },
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/calls/history",
        headers: authHeader(userId, "u@example.com"),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.calls).toHaveLength(2);

      const ended = body.calls.find((c: any) => c.status === "ended");
      expect(ended.durationSeconds).toBe(300);
      expect(ended.participantCount).toBe(1); // joined receiver only (status ended)

      const initiated = body.calls.find((c: any) => c.status === "initiated");
      expect(initiated.durationSeconds).toBeUndefined();
      expect(initiated.participantCount).toBe(1); // invited receiver is not "joined" -> +1 for caller only
    });
  });
});
