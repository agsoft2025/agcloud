import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetFakes } from "../../helpers/mockDb.js";
import { bullmqMocks, resetBullmqMocks } from "../../helpers/mockBullmq.js";

vi.mock("../../../src/modules/notification/fcm.client.js", () => ({
  sendFcmNotification: vi.fn(),
}));

vi.mock("../../../src/modules/notification/apns.client.js", () => ({
  sendApnsNotification: vi.fn(),
  sendVoipPush: vi.fn(),
}));

import { sendFcmNotification } from "../../../src/modules/notification/fcm.client.js";
import { sendApnsNotification, sendVoipPush } from "../../../src/modules/notification/apns.client.js";
import {
  enqueuePushFallback,
  startPushFallbackWorker,
  stopPushFallbackWorker,
  type PushFallbackJob,
} from "../../../src/modules/notification/notification.queue.js";

describe("notification.queue", () => {
  beforeEach(() => {
    resetFakes();
    resetBullmqMocks();
    vi.mocked(sendFcmNotification).mockReset();
    vi.mocked(sendApnsNotification).mockReset();
    vi.mocked(sendVoipPush).mockReset();
  });

  afterEach(async () => {
    await stopPushFallbackWorker();
    vi.restoreAllMocks();
  });

  describe("enqueuePushFallback", () => {
    it("adds a delayed, retryable, dead-letter-preserving job", async () => {
      const job: PushFallbackJob = {
        platform: "android",
        token: "and-tok",
        isVoip: false,
        title: "Incoming Call",
        body: "Alice is calling",
        data: { type: "incoming_call" },
      };
      await enqueuePushFallback(job);

      expect(bullmqMocks.add).toHaveBeenCalledWith(
        "push",
        job,
        expect.objectContaining({
          delay: 120_000,
          attempts: 3,
          removeOnComplete: true,
          removeOnFail: false,
        })
      );
    });

    it("swallows a queue error instead of throwing (fire-and-forget from notification.service)", async () => {
      bullmqMocks.add.mockRejectedValueOnce(new Error("redis down"));
      await expect(
        enqueuePushFallback({
          platform: "web",
          token: "tok",
          isVoip: false,
          title: "t",
          body: "b",
          data: {},
        })
      ).resolves.toBeUndefined();
    });
  });

  describe("startPushFallbackWorker / job processor", () => {
    function captureProcessor() {
      startPushFallbackWorker();
      const processor = bullmqMocks.lastWorkerProcessor;
      expect(processor).toBeInstanceOf(Function);
      return processor as (job: { data: PushFallbackJob }) => Promise<void>;
    }

    it("is idempotent — calling twice reuses the same worker", () => {
      const w1 = startPushFallbackWorker();
      const w2 = startPushFallbackWorker();
      expect(w1).toBe(w2);
    });

    it("resends an FCM (android/web) push and succeeds", async () => {
      vi.mocked(sendFcmNotification).mockResolvedValueOnce({ ok: true });
      const processor = captureProcessor();

      await processor({
        data: { platform: "android", token: "and-tok", isVoip: false, title: "t", body: "b", data: { a: "1" } },
      });

      expect(sendFcmNotification).toHaveBeenCalledWith({ token: "and-tok", title: "t", body: "b", data: { a: "1" } });
    });

    it("resends an APNs alert push for ios/non-voip and succeeds", async () => {
      vi.mocked(sendApnsNotification).mockResolvedValueOnce({ ok: true });
      const processor = captureProcessor();

      await processor({
        data: { platform: "ios", token: "ios-tok", isVoip: false, title: "t", body: "b", data: {} },
      });

      expect(sendApnsNotification).toHaveBeenCalledWith(
        expect.objectContaining({ deviceToken: "ios-tok", pushType: "alert" })
      );
      expect(sendVoipPush).not.toHaveBeenCalled();
    });

    it("resends a VoIP push for ios/voip and succeeds", async () => {
      vi.mocked(sendVoipPush).mockResolvedValueOnce({ ok: true });
      const processor = captureProcessor();

      await processor({
        data: { platform: "ios", token: "voip-tok", isVoip: true, title: "t", body: "b", data: { a: "1" } },
      });

      expect(sendVoipPush).toHaveBeenCalledWith("voip-tok", { a: "1" });
      expect(sendApnsNotification).not.toHaveBeenCalled();
    });

    it("throws (fails the BullMQ job, triggering its own retry/backoff) when delivery fails", async () => {
      vi.mocked(sendFcmNotification).mockResolvedValueOnce({ ok: false });
      const processor = captureProcessor();

      await expect(
        processor({
          data: { platform: "android", token: "and-tok", isVoip: false, title: "t", body: "b", data: {} },
        })
      ).rejects.toThrow();
    });

    it("throws when the token is now reported permanently invalid", async () => {
      vi.mocked(sendFcmNotification).mockResolvedValueOnce({ ok: false, permanentFailure: true });
      const processor = captureProcessor();

      await expect(
        processor({
          data: { platform: "android", token: "and-tok", isVoip: false, title: "t", body: "b", data: {} },
        })
      ).rejects.toThrow(/permanently invalid/);
    });
  });
});
