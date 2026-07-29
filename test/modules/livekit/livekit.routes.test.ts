import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../../helpers/buildTestApp.js";
import { getFakeDb, resetFakes } from "../../helpers/mockDb.js";
import { livekitMocks } from "../../helpers/mockLivekit.js";
import { makeCallDoc } from "../../helpers/fixtures.js";
import config from "../../../src/config/index.js";

describe("LiveKit Webhook Routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetFakes();
    livekitMocks.deleteRoom.mockResolvedValue(undefined);
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  async function seedCall(overrides: Record<string, unknown> = {}) {
    const doc = makeCallDoc(overrides);
    await getFakeDb().collection("calls").insertOne(doc);
    return doc;
  }

  it("returns 400 with 'Empty body' for an empty raw body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      payload: "",
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toBe("Empty body");
  });

  it("returns 401 when the authorization header is missing in production", async () => {
    const original = config.env;
    (config as any).env = "production";
    try {
      const response = await app.inject({
        method: "POST",
        url: "/livekit/webhook",
        payload: JSON.stringify({ event: "room_finished" }),
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.payload).message).toBe("Missing Authorization header");
    } finally {
      (config as any).env = original;
    }
  });

  it("returns 400 'Empty event' when the dev-bypass body parses to a falsy value", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      payload: "null",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toBe("Empty event");
  });

  it("returns 400 'Invalid webhook signature' when an authorization header is present and receive() rejects", async () => {
    livekitMocks.webhookReceive.mockRejectedValueOnce(new Error("bad signature"));

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { authorization: "Bearer sometoken", "content-type": "application/json" },
      payload: JSON.stringify({ event: "room_finished", room: { name: "whatever" } }),
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toBe("Invalid webhook signature");
  });

  it("processes the event when a valid HMAC-signed authorization header is present (receive() resolves)", async () => {
    const call = await seedCall({ status: "active" });
    const callId = call._id.toString();
    const event = { event: "room_finished", room: { name: callId } };
    livekitMocks.webhookReceive.mockResolvedValueOnce(event);

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { authorization: "Bearer valid-signature-token", "content-type": "application/json" },
      payload: JSON.stringify(event),
    });
    expect(response.statusCode).toBe(200);
    // The verified event object came from receive(), not JSON.parse(rawBody) —
    // proves the signature-verified path (not the dev bypass) was used.
    expect(livekitMocks.webhookReceive).toHaveBeenCalledWith(JSON.stringify(event), "Bearer valid-signature-token");

    const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
    expect(updated!.status).toBe("ended");
  });

  it("verifies signatures even outside production when an authorization header is present", async () => {
    // Dev bypass only applies when the header is absent — if a client sends
    // one, it must still be verified even in a non-production environment.
    livekitMocks.webhookReceive.mockRejectedValueOnce(new Error("bad signature"));

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { authorization: "Bearer forged-token", "content-type": "application/json" },
      payload: JSON.stringify({ event: "room_finished", room: { name: "whatever" } }),
    });
    expect(response.statusCode).toBe(400);
    expect(livekitMocks.webhookReceive).toHaveBeenCalled();
  });

  it("room_finished: ends an active/initiated call and marks pending invites missed", async () => {
    const call = await seedCall({
      status: "active",
      receiverIds: ["callee-1", "pending-1"],
      participants: {
        "callee-1": { status: "joined", invitedAt: new Date(), invitedBy: "caller-1" },
        "pending-1": { status: "invited", invitedAt: new Date(), invitedBy: "caller-1" },
      },
    });
    const callId = call._id.toString();

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "room_finished", room: { name: callId } }),
    });
    expect(response.statusCode).toBe(200);

    const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
    expect(updated!.status).toBe("ended");
    expect(updated!.participants["pending-1"].status).toBe("missed");
  });

  it("dedups a redelivered event by id (spec §6.2) — second delivery is a no-op", async () => {
    const call = await seedCall({ status: "active" });
    const callId = call._id.toString();
    const payload = JSON.stringify({ event: "room_finished", room: { name: callId }, id: "evt-dup-1" });

    const first = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.payload)).toEqual({ received: true });

    const second = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.payload)).toEqual({ received: true, duplicate: true });

    // Only the first delivery's write should have happened — the call is
    // ended, and a second processing pass didn't run into it a second time.
    const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
    expect(updated!.status).toBe("ended");
  });

  it("processes two different event ids independently (not treated as duplicates of each other)", async () => {
    const call = await seedCall({ status: "initiated", callerId: "caller-1", receiverIds: ["callee-1"] });
    const callId = call._id.toString();

    const joined = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        event: "participant_joined",
        room: { name: callId },
        participant: { identity: "callee-1" },
        id: "evt-a",
      }),
    });
    expect(JSON.parse(joined.payload)).toEqual({ received: true });

    const finished = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "room_finished", room: { name: callId }, id: "evt-b" }),
    });
    expect(JSON.parse(finished.payload)).toEqual({ received: true });

    const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
    expect(updated!.status).toBe("ended");
  });

  it("room_started: acknowledges without touching the call record (spec §2.4: log-only)", async () => {
    const call = await seedCall({ status: "initiated" });
    const callId = call._id.toString();

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "room_started", room: { name: callId } }),
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ received: true });

    const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
    expect(updated!.status).toBe("initiated");
  });

  it("track_published: acknowledges for an audio track on a known call (relayed live, not persisted)", async () => {
    const call = await seedCall({ status: "active", callerId: "caller-1", receiverIds: ["callee-1"] });
    const callId = call._id.toString();

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        event: "track_published",
        room: { name: callId },
        participant: { identity: "callee-1" },
        track: { type: 0 }, // AUDIO
      }),
    });
    expect(response.statusCode).toBe(200);

    const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
    expect(updated!.status).toBe("active");
  });

  it("track_unpublished: acknowledges for a video track", async () => {
    const call = await seedCall({ status: "active", callerId: "caller-1", receiverIds: ["callee-1"] });
    const callId = call._id.toString();

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        event: "track_unpublished",
        room: { name: callId },
        participant: { identity: "caller-1" },
        track: { type: 1 }, // VIDEO
      }),
    });
    expect(response.statusCode).toBe(200);
  });

  it("track_published: is a no-op for a DATA track (not audio/video)", async () => {
    const call = await seedCall({ status: "active", callerId: "caller-1", receiverIds: ["callee-1"] });
    const callId = call._id.toString();

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        event: "track_published",
        room: { name: callId },
        participant: { identity: "callee-1" },
        track: { type: 2 }, // DATA
      }),
    });
    expect(response.statusCode).toBe(200);
  });

  it("track_published: is a no-op when the call doesn't exist", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        event: "track_published",
        room: { name: "no-such-call" },
        participant: { identity: "someone" },
        track: { type: 0 },
      }),
    });
    expect(response.statusCode).toBe(200);
  });

  it("room_finished: leaves a call already ended untouched", async () => {
    const call = await seedCall({ status: "ended" });
    const callId = call._id.toString();

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "room_finished", room: { name: callId } }),
    });
    expect(response.statusCode).toBe(200);
    const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
    expect(updated!.status).toBe("ended");
  });

  it("participant_joined: transitions initiated -> active only when the joiner isn't the caller", async () => {
    const call = await seedCall({ status: "initiated", callerId: "caller-1", receiverIds: ["callee-1"] });
    const callId = call._id.toString();

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        event: "participant_joined",
        room: { name: callId },
        participant: { identity: "callee-1" },
      }),
    });
    expect(response.statusCode).toBe(200);
    const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
    expect(updated!.status).toBe("active");
  });

  it("participant_joined: does not transition when the caller itself joins", async () => {
    const call = await seedCall({ status: "initiated", callerId: "caller-1", receiverIds: ["callee-1"] });
    const callId = call._id.toString();

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        event: "participant_joined",
        room: { name: callId },
        participant: { identity: "caller-1" },
      }),
    });
    expect(response.statusCode).toBe(200);
    const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
    expect(updated!.status).toBe("initiated");
  });

  it("participant_left: ends a one-to-one active/initiated call and calls endLiveKitRoom", async () => {
    const call = await seedCall({ status: "active", callMode: "one-to-one" });
    const callId = call._id.toString();

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "participant_left", room: { name: callId } }),
    });
    expect(response.statusCode).toBe(200);
    const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
    expect(updated!.status).toBe("ended");
    expect(livekitMocks.deleteRoom).toHaveBeenCalled();
  });

  it("participant_left: leaves a conference call untouched", async () => {
    const call = await seedCall({ status: "active", callMode: "conference" });
    const callId = call._id.toString();

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "participant_left", room: { name: callId } }),
    });
    expect(response.statusCode).toBe(200);
    const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
    expect(updated!.status).toBe("active");
  });

  it("egress_ended: saves the recording URL and marks recording false", async () => {
    const call = await seedCall({ recording: true, egressId: "egress-abc" });

    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        event: "egress_ended",
        egressInfo: {
          egressId: "egress-abc",
          fileResults: [{ location: "https://example.com/rec.mp4" }],
        },
      }),
    });
    expect(response.statusCode).toBe(200);
    const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
    expect(updated!.recordingUrl).toBe("https://example.com/rec.mp4");
    expect(updated!.recording).toBe(false);
  });

  it("returns 200 with received:true for an unrecognized event type", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "some_unknown_event" }),
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload).received).toBe(true);
  });
});
