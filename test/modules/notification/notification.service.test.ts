import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFakeDb, resetFakes } from "../../helpers/mockDb.js";
import { makeDeviceDoc } from "../../helpers/fixtures.js";

vi.mock("../../../src/modules/notification/apns.client.js", () => ({
  sendApnsNotification: vi.fn().mockResolvedValue(true),
  sendVoipPush: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../src/modules/notification/fcm.client.js", () => ({
  sendFcmNotification: vi.fn().mockResolvedValue(true),
}));

import { sendApnsNotification, sendVoipPush } from "../../../src/modules/notification/apns.client.js";
import { sendFcmNotification } from "../../../src/modules/notification/fcm.client.js";
import {
  registerDevice,
  unregisterDevice,
  notifyIncomingCall,
  notifyMissedCall,
  type DeviceDocument,
} from "../../../src/modules/notification/notification.service.js";

describe("notification.service", () => {
  beforeEach(() => {
    resetFakes();
    vi.clearAllMocks();
  });

  function col() {
    return getFakeDb().collection<DeviceDocument>("devices");
  }

  describe("registerDevice", () => {
    it("upserts a device by userId/platform/token", async () => {
      await registerDevice("user-1", "ios", "token-abc", "voip-abc");
      const docs = await col().find({ userId: "user-1" }).toArray();
      expect(docs).toHaveLength(1);
      expect(docs[0].platform).toBe("ios");
      expect(docs[0].token).toBe("token-abc");
      expect(docs[0].voipToken).toBe("voip-abc");
      expect(docs[0].createdAt).toBeTruthy();
      expect(docs[0].updatedAt).toBeTruthy();
    });

    it("updates an existing device on re-registration instead of duplicating", async () => {
      await registerDevice("user-1", "ios", "token-abc");
      await registerDevice("user-1", "ios", "token-abc", "voip-xyz");
      const docs = await col().find({ userId: "user-1" }).toArray();
      expect(docs).toHaveLength(1);
      expect(docs[0].voipToken).toBe("voip-xyz");
    });
  });

  describe("unregisterDevice", () => {
    it("deletes the device matching userId and token", async () => {
      await col().insertOne(makeDeviceDoc({ userId: "user-1", token: "token-abc" }));
      await unregisterDevice("user-1", "token-abc");
      const docs = await col().find({ userId: "user-1" }).toArray();
      expect(docs).toHaveLength(0);
    });
  });

  describe("notifyIncomingCall", () => {
    const payload = {
      callId: "call-1",
      callerId: "caller-1",
      callerName: "Alice",
      callType: "audio" as const,
      roomId: "room-1",
    };

    it("sends a voip push for ios devices with a voipToken", async () => {
      await col().insertOne(makeDeviceDoc({ userId: "user-1", platform: "ios", token: "tok", voipToken: "voip-tok" }));
      await notifyIncomingCall("user-1", payload);
      expect(sendVoipPush).toHaveBeenCalledWith("voip-tok", expect.objectContaining({ callId: "call-1", type: "incoming_call" }));
      expect(sendApnsNotification).not.toHaveBeenCalled();
    });

    it("sends an apns alert push for ios devices without a voipToken", async () => {
      await col().insertOne(makeDeviceDoc({ userId: "user-1", platform: "ios", token: "tok" }));
      await notifyIncomingCall("user-1", payload);
      expect(sendApnsNotification).toHaveBeenCalledWith(
        expect.objectContaining({ deviceToken: "tok", pushType: "alert" })
      );
      expect(sendVoipPush).not.toHaveBeenCalled();
    });

    it("sends an fcm push for android devices", async () => {
      await col().insertOne(makeDeviceDoc({ userId: "user-1", platform: "android", token: "and-tok" }));
      await notifyIncomingCall("user-1", payload);
      expect(sendFcmNotification).toHaveBeenCalledWith(
        expect.objectContaining({ token: "and-tok", title: "Incoming Call", priority: "high", ttl: 60 })
      );
    });

    it("fans out to every device across multiple platforms", async () => {
      await col().insertOne(makeDeviceDoc({ userId: "user-1", platform: "ios", token: "ios-tok", voipToken: "voip-tok" }));
      await col().insertOne(makeDeviceDoc({ userId: "user-1", platform: "android", token: "and-tok" }));
      await notifyIncomingCall("user-1", payload);
      expect(sendVoipPush).toHaveBeenCalledTimes(1);
      expect(sendFcmNotification).toHaveBeenCalledTimes(1);
    });

    it("does nothing when the user has no devices", async () => {
      await notifyIncomingCall("user-no-devices", payload);
      expect(sendApnsNotification).not.toHaveBeenCalled();
      expect(sendFcmNotification).not.toHaveBeenCalled();
      expect(sendVoipPush).not.toHaveBeenCalled();
    });

    it("does not throw when fetching devices fails, and skips notifications", async () => {
      vi.spyOn(col(), "find").mockImplementation(() => {
        throw new Error("db down");
      });
      await expect(notifyIncomingCall("user-1", payload)).resolves.toBeUndefined();
      expect(sendApnsNotification).not.toHaveBeenCalled();
      expect(sendFcmNotification).not.toHaveBeenCalled();
    });
  });

  describe("notifyMissedCall", () => {
    const payload = { callId: "call-1", callerName: "Alice" };

    it("sends an apns push for ios devices", async () => {
      await col().insertOne(makeDeviceDoc({ userId: "user-1", platform: "ios", token: "tok" }));
      await notifyMissedCall("user-1", payload);
      expect(sendApnsNotification).toHaveBeenCalledWith(
        expect.objectContaining({ deviceToken: "tok", aps: expect.objectContaining({ alert: expect.any(Object) }) })
      );
    });

    it("sends an fcm push for android/web devices", async () => {
      await col().insertOne(makeDeviceDoc({ userId: "user-1", platform: "web", token: "web-tok" }));
      await notifyMissedCall("user-1", payload);
      expect(sendFcmNotification).toHaveBeenCalledWith(
        expect.objectContaining({ token: "web-tok", title: "Missed Call" })
      );
    });

    it("does not throw when fetching devices fails", async () => {
      vi.spyOn(col(), "find").mockImplementation(() => {
        throw new Error("db down");
      });
      await expect(notifyMissedCall("user-1", payload)).resolves.toBeUndefined();
    });
  });

  describe("dead-token pruning", () => {
    it("unregisters an Android/FCM device whose token was reported permanently invalid", async () => {
      await col().insertOne(makeDeviceDoc({ userId: "user-1", platform: "android", token: "dead-tok" }));
      vi.mocked(sendFcmNotification).mockResolvedValueOnce({ ok: false, permanentFailure: true });

      await notifyIncomingCall("user-1", {
        callId: "call-1", callerId: "caller-1", callerName: "Alice", callType: "audio", roomId: "room-1",
      });

      const remaining = await col().find({ userId: "user-1" }).toArray();
      expect(remaining).toHaveLength(0);
    });

    it("unregisters an iOS/APNs device (no voipToken) whose token was reported permanently invalid", async () => {
      await col().insertOne(makeDeviceDoc({ userId: "user-1", platform: "ios", token: "dead-tok" }));
      vi.mocked(sendApnsNotification).mockResolvedValueOnce({ ok: false, permanentFailure: true });

      await notifyIncomingCall("user-1", {
        callId: "call-1", callerId: "caller-1", callerName: "Alice", callType: "audio", roomId: "room-1",
      });

      const remaining = await col().find({ userId: "user-1" }).toArray();
      expect(remaining).toHaveLength(0);
    });

    it("clears only the voipToken (keeps the device) when a VoIP push permanently fails", async () => {
      await col().insertOne(
        makeDeviceDoc({ userId: "user-1", platform: "ios", token: "alert-tok", voipToken: "dead-voip-tok" })
      );
      vi.mocked(sendVoipPush).mockResolvedValueOnce({ ok: false, permanentFailure: true });

      await notifyIncomingCall("user-1", {
        callId: "call-1", callerId: "caller-1", callerName: "Alice", callType: "audio", roomId: "room-1",
      });

      const remaining = await col().find({ userId: "user-1" }).toArray();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].token).toBe("alert-tok");
      expect(remaining[0].voipToken).toBeUndefined();
    });

    it("does not prune a device on a transient (non-permanent) failure", async () => {
      await col().insertOne(makeDeviceDoc({ userId: "user-1", platform: "android", token: "flaky-tok" }));
      vi.mocked(sendFcmNotification).mockResolvedValueOnce({ ok: false });

      await notifyIncomingCall("user-1", {
        callId: "call-1", callerId: "caller-1", callerName: "Alice", callType: "audio", roomId: "room-1",
      });

      const remaining = await col().find({ userId: "user-1" }).toArray();
      expect(remaining).toHaveLength(1);
    });

    it("also prunes on permanent failure from notifyMissedCall", async () => {
      await col().insertOne(makeDeviceDoc({ userId: "user-1", platform: "android", token: "dead-tok" }));
      vi.mocked(sendFcmNotification).mockResolvedValueOnce({ ok: false, permanentFailure: true });

      await notifyMissedCall("user-1", { callId: "call-1", callerName: "Alice" });

      const remaining = await col().find({ userId: "user-1" }).toArray();
      expect(remaining).toHaveLength(0);
    });
  });
});
