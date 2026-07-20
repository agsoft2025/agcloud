import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ObjectId } from "mongodb";
import { getFakeDb, resetFakes } from "../../helpers/mockDb.js";
import { livekitMocks } from "../../helpers/mockLivekit.js";
import { bullmqMocks, resetBullmqMocks } from "../../helpers/mockBullmq.js";
import { makeCallDoc } from "../../helpers/fixtures.js";
import {
  scheduleCallTimeout,
  cancelCallTimeout,
  startCallTimeoutWorker,
  stopCallTimeoutWorker,
} from "../../../src/modules/call/call.queue.js";

describe("call.queue", () => {
  beforeEach(() => {
    resetFakes();
    resetBullmqMocks();
    livekitMocks.deleteRoom.mockClear().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await stopCallTimeoutWorker();
    vi.restoreAllMocks();
  });

  describe("scheduleCallTimeout", () => {
    it("adds a delayed job keyed by callId with a 60s delay", async () => {
      await scheduleCallTimeout("call-abc");

      expect(bullmqMocks.add).toHaveBeenCalledWith(
        "timeout",
        { callId: "call-abc" },
        expect.objectContaining({ delay: 60_000, jobId: "call-abc", removeOnComplete: true, removeOnFail: true })
      );
    });

    it("swallows a queue error instead of throwing (fire-and-forget from the route handler)", async () => {
      bullmqMocks.add.mockRejectedValueOnce(new Error("redis down"));
      await expect(scheduleCallTimeout("call-abc")).resolves.toBeUndefined();
    });
  });

  describe("cancelCallTimeout", () => {
    it("removes the job when found", async () => {
      bullmqMocks.getJob.mockResolvedValueOnce({});
      await cancelCallTimeout("call-abc");

      expect(bullmqMocks.getJob).toHaveBeenCalledWith("call-abc");
      expect(bullmqMocks.jobRemove).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when no job is found", async () => {
      bullmqMocks.getJob.mockResolvedValueOnce(null);
      await cancelCallTimeout("call-abc");
      expect(bullmqMocks.jobRemove).not.toHaveBeenCalled();
    });

    it("swallows an error instead of throwing", async () => {
      bullmqMocks.getJob.mockRejectedValueOnce(new Error("redis down"));
      await expect(cancelCallTimeout("call-abc")).resolves.toBeUndefined();
    });
  });

  describe("startCallTimeoutWorker / job processor", () => {
    // The mocked Worker constructor never actually invokes the processor —
    // that's real BullMQ's job. mockBullmq.ts's Worker mock captures whatever
    // processor it was constructed with so tests can invoke it directly.
    function captureProcessor() {
      startCallTimeoutWorker();
      const processor = bullmqMocks.lastWorkerProcessor;
      expect(processor).toBeInstanceOf(Function);
      return processor as (job: { data: { callId: string } }) => Promise<void>;
    }

    it("is idempotent — calling twice reuses the same worker", () => {
      const w1 = startCallTimeoutWorker();
      const w2 = startCallTimeoutWorker();
      expect(w1).toBe(w2);
    });

    it("transitions a still-initiated call to missed, marks pending invites missed, and ends the room", async () => {
      const processor = await captureProcessor();

      const call = makeCallDoc({
        status: "initiated",
        participants: { "callee-1": { status: "invited", invitedAt: new Date(), invitedBy: "caller-1" } },
      });
      await getFakeDb().collection("calls").insertOne(call as any);

      await processor({ data: { callId: call._id.toString() } });

      const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
      expect(updated!.status).toBe("missed");
      expect(updated!.participants["callee-1"].status).toBe("missed");
      expect(livekitMocks.deleteRoom).toHaveBeenCalled();
    });

    it("is a no-op when the call was already accepted/cancelled/ended before the job fired", async () => {
      const processor = await captureProcessor();

      const call = makeCallDoc({ status: "active" });
      await getFakeDb().collection("calls").insertOne(call as any);

      await processor({ data: { callId: call._id.toString() } });

      const updated = await getFakeDb().collection("calls").findOne({ _id: call._id });
      expect(updated!.status).toBe("active");
      expect(livekitMocks.deleteRoom).not.toHaveBeenCalled();
    });

    it("is a no-op when the call no longer exists", async () => {
      const processor = await captureProcessor();
      await expect(processor({ data: { callId: new ObjectId().toString() } })).resolves.toBeUndefined();
      expect(livekitMocks.deleteRoom).not.toHaveBeenCalled();
    });
  });
});
