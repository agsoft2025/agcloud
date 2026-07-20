import { describe, it, expect, beforeEach } from "vitest";
import { resetFakes } from "../../helpers/mockDb.js";
import { BlockRepository } from "../../../src/modules/contact/block.repository.js";

describe("BlockRepository", () => {
  let repo: BlockRepository;

  beforeEach(() => {
    resetFakes();
    repo = new BlockRepository();
  });

  describe("block / listBlockedIds", () => {
    it("blocks a user and lists it back", async () => {
      await repo.block("blocker-1", "blocked-1");
      expect(await repo.listBlockedIds("blocker-1")).toEqual(["blocked-1"]);
    });

    it("is idempotent — blocking the same user twice does not duplicate it", async () => {
      await repo.block("blocker-1", "blocked-1");
      await repo.block("blocker-1", "blocked-1");
      expect(await repo.listBlockedIds("blocker-1")).toEqual(["blocked-1"]);
    });
  });

  describe("unblock", () => {
    it("removes an existing block and returns true", async () => {
      await repo.block("blocker-1", "blocked-1");
      expect(await repo.unblock("blocker-1", "blocked-1")).toBe(true);
      expect(await repo.listBlockedIds("blocker-1")).toEqual([]);
    });

    it("returns false when there was nothing to remove", async () => {
      expect(await repo.unblock("blocker-1", "blocked-1")).toBe(false);
    });
  });

  describe("isBlockedEitherWay", () => {
    it("is true when A blocked B", async () => {
      await repo.block("user-a", "user-b");
      expect(await repo.isBlockedEitherWay("user-a", "user-b")).toBe(true);
    });

    it("is true when B blocked A (direction-agnostic)", async () => {
      await repo.block("user-b", "user-a");
      expect(await repo.isBlockedEitherWay("user-a", "user-b")).toBe(true);
    });

    it("is false when neither has blocked the other", async () => {
      expect(await repo.isBlockedEitherWay("user-a", "user-b")).toBe(false);
    });
  });

  describe("filterBlockedEitherWay", () => {
    it("returns candidates blocked in either direction relative to userId", async () => {
      await repo.block("me", "candidate-1"); // I blocked candidate-1
      await repo.block("candidate-2", "me"); // candidate-2 blocked me
      // candidate-3: no relationship

      const blocked = await repo.filterBlockedEitherWay("me", ["candidate-1", "candidate-2", "candidate-3"]);
      expect(blocked.sort()).toEqual(["candidate-1", "candidate-2"].sort());
    });

    it("returns an empty array for an empty candidate list without querying", async () => {
      expect(await repo.filterBlockedEitherWay("me", [])).toEqual([]);
    });

    it("returns an empty array when none of the candidates are blocked", async () => {
      expect(await repo.filterBlockedEitherWay("me", ["stranger-1", "stranger-2"])).toEqual([]);
    });
  });
});
