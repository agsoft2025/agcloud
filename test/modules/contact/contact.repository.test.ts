import { describe, it, expect, beforeEach } from "vitest";
import { resetFakes } from "../../helpers/mockDb.js";
import { ContactRepository } from "../../../src/modules/contact/contact.repository.js";

describe("ContactRepository", () => {
  let repo: ContactRepository;

  beforeEach(() => {
    resetFakes();
    repo = new ContactRepository();
  });

  describe("addContact / listContactIds", () => {
    it("adds a contact and lists it back", async () => {
      await repo.addContact("owner-1", "contact-1");
      expect(await repo.listContactIds("owner-1")).toEqual(["contact-1"]);
    });

    it("is idempotent — adding the same contact twice does not duplicate it", async () => {
      await repo.addContact("owner-1", "contact-1");
      await repo.addContact("owner-1", "contact-1");
      expect(await repo.listContactIds("owner-1")).toEqual(["contact-1"]);
    });

    it("keeps contact lists scoped per owner", async () => {
      await repo.addContact("owner-1", "contact-1");
      expect(await repo.listContactIds("owner-2")).toEqual([]);
    });
  });

  describe("removeContact", () => {
    it("removes an existing contact and returns true", async () => {
      await repo.addContact("owner-1", "contact-1");
      expect(await repo.removeContact("owner-1", "contact-1")).toBe(true);
      expect(await repo.listContactIds("owner-1")).toEqual([]);
    });

    it("returns false when there was nothing to remove", async () => {
      expect(await repo.removeContact("owner-1", "contact-1")).toBe(false);
    });
  });

  describe("isContact", () => {
    it("returns true only for an existing owner/contact pair", async () => {
      await repo.addContact("owner-1", "contact-1");
      expect(await repo.isContact("owner-1", "contact-1")).toBe(true);
      expect(await repo.isContact("owner-1", "contact-2")).toBe(false);
      expect(await repo.isContact("owner-2", "contact-1")).toBe(false);
    });
  });

  describe("getWatchersOf", () => {
    it("returns every owner who has the given user as a contact", async () => {
      await repo.addContact("watcher-1", "target-1");
      await repo.addContact("watcher-2", "target-1");
      await repo.addContact("watcher-1", "target-2");

      const watchers = await repo.getWatchersOf("target-1");
      expect(watchers.sort()).toEqual(["watcher-1", "watcher-2"].sort());
    });

    it("returns an empty array when nobody has added this user as a contact", async () => {
      expect(await repo.getWatchersOf("nobody-cares-about-me")).toEqual([]);
    });
  });
});
