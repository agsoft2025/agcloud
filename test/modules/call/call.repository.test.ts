import { describe, it, expect, beforeEach, vi } from "vitest";
import { ObjectId } from "mongodb";
import { getFakeDb, resetFakes } from "../../helpers/mockDb.js";
import { CallRepository, DuplicateActiveCallError } from "../../../src/modules/call/call.repository.js";
import { makeCallDoc } from "../../helpers/fixtures.js";
import type { CallDocument } from "../../../src/modules/call/call.schemas.js";

describe("CallRepository", () => {
  let repo: CallRepository;

  beforeEach(() => {
    resetFakes();
    repo = new CallRepository();
  });

  function col() {
    return getFakeDb().collection<CallDocument>("calls");
  }

  describe("createCall", () => {
    it("creates a call and sets roomId to the generated _id", async () => {
      const call = await repo.createCall(
        "caller-1",
        ["callee-1", "callee-2"],
        "video",
        "conference"
      );

      expect(call._id).toBeTruthy();
      expect(call.roomId).toBe(call._id.toString());
      expect(call.callerId).toBe("caller-1");
      expect(call.calleeId).toBe("callee-1");
      expect(call.receiverIds).toEqual(["callee-1", "callee-2"]);
      expect(call.status).toBe("initiated");
      expect(call.participants["callee-1"].status).toBe("invited");
      expect(call.participants["callee-2"].invitedBy).toBe("caller-1");

      const stored = await col().findOne({ _id: call._id });
      expect(stored!.roomId).toBe(call._id.toString());
    });

    it("defaults calleeId to empty string when receiverIds is empty", async () => {
      const call = await repo.createCall("caller-1", [], "audio", "one-to-one");
      expect(call.calleeId).toBe("");
    });

    it("spec §10.2 'simultaneous initiation': translates a caller_active unique-index violation into DuplicateActiveCallError", async () => {
      const duplicateKeyError = Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
      vi.spyOn(col(), "insertOne").mockRejectedValueOnce(duplicateKeyError);

      await expect(repo.createCall("caller-1", ["callee-1"], "audio", "one-to-one")).rejects.toThrow(
        DuplicateActiveCallError
      );
    });

    it("does not swallow a non-duplicate-key insert error", async () => {
      vi.spyOn(col(), "insertOne").mockRejectedValueOnce(new Error("connection reset"));

      await expect(repo.createCall("caller-1", ["callee-1"], "audio", "one-to-one")).rejects.toThrow(
        "connection reset"
      );
    });
  });

  describe("getCallById", () => {
    it("returns the call when found", async () => {
      const seeded = makeCallDoc();
      await col().insertOne(seeded);
      const found = await repo.getCallById(seeded._id.toString());
      expect(found?._id.toString()).toBe(seeded._id.toString());
    });

    it("returns null for an invalid ObjectId string instead of throwing", async () => {
      await expect(repo.getCallById("not-an-object-id")).resolves.toBeNull();
    });

    it("returns null when not found", async () => {
      const found = await repo.getCallById(new ObjectId().toString());
      expect(found).toBeNull();
    });
  });

  describe("updateCallStatus", () => {
    it("sets startedAt when status is active", async () => {
      const seeded = makeCallDoc({ status: "initiated" });
      await col().insertOne(seeded);
      const ok = await repo.updateCallStatus(seeded._id.toString(), "active");
      expect(ok).toBe(true);
      const updated = await col().findOne({ _id: seeded._id });
      expect(updated!.status).toBe("active");
      expect(updated!.startedAt).toBeTruthy();
    });

    it("sets endedAt for rejected", async () => {
      const seeded = makeCallDoc({ status: "active" });
      await col().insertOne(seeded);
      await repo.updateCallStatus(seeded._id.toString(), "rejected");
      const updated = await col().findOne({ _id: seeded._id });
      expect(updated!.status).toBe("rejected");
      expect(updated!.endedAt).toBeTruthy();
    });

    it("sets endedAt for ended", async () => {
      const seeded = makeCallDoc({ status: "active" });
      await col().insertOne(seeded);
      await repo.updateCallStatus(seeded._id.toString(), "ended");
      const updated = await col().findOne({ _id: seeded._id });
      expect(updated!.status).toBe("ended");
      expect(updated!.endedAt).toBeTruthy();
    });

    it("merges an extra partial into the update", async () => {
      const seeded = makeCallDoc({ status: "active" });
      await col().insertOne(seeded);
      await repo.updateCallStatus(seeded._id.toString(), "ended", {
        recordingUrl: "https://example.com/rec.mp4",
      });
      const updated = await col().findOne({ _id: seeded._id });
      expect(updated!.recordingUrl).toBe("https://example.com/rec.mp4");
    });

    it("returns false on an invalid id", async () => {
      const ok = await repo.updateCallStatus("bad-id", "active");
      expect(ok).toBe(false);
    });
  });

  describe("getCallHistoryForUser", () => {
    it("matches callerId, calleeId, or receiverIds member, sorted desc by createdAt, respecting limit", async () => {
      const now = Date.now();
      const c1 = makeCallDoc({ callerId: "user-1", createdAt: new Date(now - 3000) });
      const c2 = makeCallDoc({
        calleeId: "user-1",
        callerId: "other",
        createdAt: new Date(now - 2000),
      });
      const c3 = makeCallDoc({
        callerId: "other",
        calleeId: "other2",
        receiverIds: ["user-1"],
        createdAt: new Date(now - 1000),
      });
      const cOther = makeCallDoc({
        callerId: "someone-else",
        calleeId: "another",
        receiverIds: [],
        createdAt: new Date(now),
      });
      await col().insertOne(c1);
      await col().insertOne(c2);
      await col().insertOne(c3);
      await col().insertOne(cOther);

      const history = await repo.getCallHistoryForUser("user-1", 20);
      expect(history).toHaveLength(3);
      expect(history.map((c) => c._id.toString())).toEqual([
        c3._id.toString(),
        c2._id.toString(),
        c1._id.toString(),
      ]);
    });

    it("respects the limit parameter", async () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        await col().insertOne(
          makeCallDoc({ callerId: "user-1", createdAt: new Date(now - i * 1000) })
        );
      }
      const history = await repo.getCallHistoryForUser("user-1", 2);
      expect(history).toHaveLength(2);
    });
  });

  describe("addParticipant", () => {
    it("adds to receiverIds and forces conference mode", async () => {
      const seeded = makeCallDoc({ callMode: "one-to-one", receiverIds: ["callee-1"] });
      await col().insertOne(seeded);
      const updated = await repo.addParticipant(seeded._id.toString(), "new-user");
      expect(updated!.receiverIds).toContain("new-user");
      expect(updated!.callMode).toBe("conference");
    });

    it("returns null on invalid call id", async () => {
      const result = await repo.addParticipant("bad-id", "new-user");
      expect(result).toBeNull();
    });
  });

  describe("inviteParticipant", () => {
    it("creates a fresh invited entry, addToSets receiverIds, forces conference mode", async () => {
      const seeded = makeCallDoc({
        callMode: "one-to-one",
        receiverIds: ["callee-1"],
        participants: {
          "callee-1": { status: "rejected", invitedAt: new Date(), invitedBy: "caller-1" },
        },
      });
      await col().insertOne(seeded);

      const updated = await repo.inviteParticipant(seeded._id.toString(), "callee-1", "caller-1");
      expect(updated!.callMode).toBe("conference");
      expect(updated!.receiverIds).toContain("callee-1");
      expect(updated!.participants["callee-1"].status).toBe("invited");
      expect(updated!.participants["callee-1"].invitedBy).toBe("caller-1");
    });

    it("returns null on invalid call id", async () => {
      const result = await repo.inviteParticipant("bad-id", "u", "caller-1");
      expect(result).toBeNull();
    });
  });

  describe("setParticipantStatus", () => {
    it("updates a participant's status and respondedAt", async () => {
      const seeded = makeCallDoc({
        participants: {
          "callee-1": { status: "invited", invitedAt: new Date(), invitedBy: "caller-1" },
        },
      });
      await col().insertOne(seeded);
      const ok = await repo.setParticipantStatus(seeded._id.toString(), "callee-1", "joined");
      expect(ok).toBe(true);
      const updated = await col().findOne({ _id: seeded._id });
      expect(updated!.participants["callee-1"].status).toBe("joined");
      expect(updated!.participants["callee-1"].respondedAt).toBeTruthy();
    });

    it("returns false on invalid call id", async () => {
      const ok = await repo.setParticipantStatus("bad-id", "callee-1", "joined");
      expect(ok).toBe(false);
    });
  });

  describe("markPendingParticipantsAs", () => {
    it("only touches invited participants, setting them to the given status", async () => {
      const seeded = makeCallDoc({
        participants: {
          "callee-1": { status: "invited", invitedAt: new Date(), invitedBy: "caller-1" },
          "callee-2": { status: "joined", invitedAt: new Date(), invitedBy: "caller-1" },
        },
      });
      await col().insertOne(seeded);
      await repo.markPendingParticipantsAs(seeded._id.toString(), "missed");
      const updated = await col().findOne({ _id: seeded._id });
      expect(updated!.participants["callee-1"].status).toBe("missed");
      expect(updated!.participants["callee-2"].status).toBe("joined");
    });

    it("supports marking pending participants as cancelled", async () => {
      const seeded = makeCallDoc({
        participants: {
          "callee-1": { status: "invited", invitedAt: new Date(), invitedBy: "caller-1" },
        },
      });
      await col().insertOne(seeded);
      await repo.markPendingParticipantsAs(seeded._id.toString(), "cancelled");
      const updated = await col().findOne({ _id: seeded._id });
      expect(updated!.participants["callee-1"].status).toBe("cancelled");
    });

    it("does nothing when call has no participants left in invited state", async () => {
      const seeded = makeCallDoc({
        participants: {
          "callee-1": { status: "joined", invitedAt: new Date(), invitedBy: "caller-1" },
        },
      });
      await col().insertOne(seeded);
      await expect(
        repo.markPendingParticipantsAs(seeded._id.toString(), "missed")
      ).resolves.toBeUndefined();
      const updated = await col().findOne({ _id: seeded._id });
      expect(updated!.participants["callee-1"].status).toBe("joined");
    });

    it("does nothing when the call doesn't exist", async () => {
      await expect(
        repo.markPendingParticipantsAs(new ObjectId().toString(), "missed")
      ).resolves.toBeUndefined();
    });

    it("swallows an updateOne failure instead of throwing", async () => {
      const seeded = makeCallDoc({
        participants: {
          "callee-1": { status: "invited", invitedAt: new Date(), invitedBy: "caller-1" },
        },
      });
      await col().insertOne(seeded);
      vi.spyOn(col(), "updateOne").mockRejectedValueOnce(new Error("db down"));

      await expect(
        repo.markPendingParticipantsAs(seeded._id.toString(), "missed")
      ).resolves.toBeUndefined();
    });
  });

  describe("getActiveCallForUser", () => {
    it("matches caller/callee/receiver AND status initiated/active", async () => {
      const active = makeCallDoc({ callerId: "user-1", status: "active" });
      const ended = makeCallDoc({ callerId: "user-1", status: "ended" });
      await col().insertOne(active);
      await col().insertOne(ended);

      const found = await repo.getActiveCallForUser("user-1");
      expect(found!._id.toString()).toBe(active._id.toString());
    });

    it("returns null when there's no active call for the user", async () => {
      await col().insertOne(makeCallDoc({ callerId: "user-1", status: "ended" }));
      const found = await repo.getActiveCallForUser("user-1");
      expect(found).toBeNull();
    });

    it("matches via receiverIds membership", async () => {
      const call = makeCallDoc({
        callerId: "someone",
        calleeId: "other",
        receiverIds: ["user-1"],
        status: "initiated",
      });
      await col().insertOne(call);
      const found = await repo.getActiveCallForUser("user-1");
      expect(found!._id.toString()).toBe(call._id.toString());
    });
  });

  describe("getActivePendingCallsForUser", () => {
    it("returns calls where the user is invited but hasn't joined", async () => {
      const pending = makeCallDoc({
        receiverIds: ["user-1"],
        status: "active",
        participants: {
          "user-1": { status: "invited", invitedAt: new Date(), invitedBy: "caller-1" },
        },
      });
      const missed = makeCallDoc({
        receiverIds: ["user-1"],
        status: "active",
        participants: {
          "user-1": { status: "missed", invitedAt: new Date(), invitedBy: "caller-1" },
        },
      });
      const joined = makeCallDoc({
        receiverIds: ["user-1"],
        status: "active",
        participants: {
          "user-1": { status: "joined", invitedAt: new Date(), invitedBy: "caller-1" },
        },
      });
      const endedCall = makeCallDoc({
        receiverIds: ["user-1"],
        status: "ended",
        participants: {
          "user-1": { status: "invited", invitedAt: new Date(), invitedBy: "caller-1" },
        },
      });
      await col().insertOne(pending);
      await col().insertOne(missed);
      await col().insertOne(joined);
      await col().insertOne(endedCall);

      const results = await repo.getActivePendingCallsForUser("user-1");
      const ids = results.map((r) => r._id.toString()).sort();
      expect(ids).toEqual([pending._id.toString(), missed._id.toString()].sort());
    });
  });

  describe("getActiveCalls", () => {
    it("returns only initiated/active calls across all users, newest first, with a total count", async () => {
      const older = makeCallDoc({ status: "active", createdAt: new Date("2026-01-01T00:00:00Z") });
      const newer = makeCallDoc({
        status: "initiated",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      });
      await col().insertOne(older);
      await col().insertOne(newer);
      await col().insertOne(makeCallDoc({ status: "ended" }));
      await col().insertOne(makeCallDoc({ status: "missed" }));
      await col().insertOne(makeCallDoc({ status: "cancelled" }));
      await col().insertOne(makeCallDoc({ status: "rejected" }));

      const { calls, total } = await repo.getActiveCalls(1, 20);

      expect(total).toBe(2);
      expect(calls.map((c) => c._id.toString())).toEqual([
        newer._id.toString(),
        older._id.toString(),
      ]);
    });

    it("paginates using page and limit", async () => {
      for (let i = 0; i < 5; i++) {
        await col().insertOne(
          makeCallDoc({ status: "active", createdAt: new Date(2026, 0, i + 1) })
        );
      }

      const page1 = await repo.getActiveCalls(1, 2);
      const page2 = await repo.getActiveCalls(2, 2);

      expect(page1.total).toBe(5);
      expect(page1.calls).toHaveLength(2);
      expect(page2.calls).toHaveLength(2);
      expect(page1.calls[0]._id.toString()).not.toBe(page2.calls[0]._id.toString());
    });
  });
});
