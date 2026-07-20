import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { getFakeDb, getFakeRedis, resetFakes } from "../../helpers/mockDb.js";
import { handleConnection, setSocketIOServer } from "../../../src/modules/presence/presence.service.js";

/**
 * Regression coverage for the "presence broadcast not scoped to contacts"
 * bug: the pub/sub subscriber used to do `io.emit(event, payload)`,
 * broadcasting every user's ONLINE/AWAY/OFFLINE transition to every
 * connected socket. It now delivers only to the user's own room and to
 * users who have that user saved as a contact (see contact.repository.ts's
 * getWatchersOf).
 */
describe("presence broadcast scoping (contact-aware delivery)", () => {
  const emittedRooms: { room: string; event: string; payload: unknown }[] = [];
  const globalEmits: { event: string; payload: unknown }[] = [];

  const fakeIo = {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          emittedRooms.push({ room, event, payload });
        },
      };
    },
    emit(event: string, payload: unknown) {
      // If any code path still calls io.emit() globally, this records it so
      // tests can assert it never happens.
      globalEmits.push({ event, payload });
    },
  };

  beforeAll(() => {
    // Attaches the pub/sub subscriber exactly once for this test file's
    // module instance — the FakeRedis's duplicate() returns the same
    // instance, so calling this more than once would double-subscribe.
    setSocketIOServer(fakeIo as any);
  });

  beforeEach(() => {
    resetFakes();
    emittedRooms.length = 0;
    globalEmits.length = 0;
  });

  async function flush(): Promise<void> {
    // The subscriber's message handler is async (it looks up contacts before
    // emitting); give its microtask queue a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("delivers a presence event to the user's own room even with no contacts", async () => {
    await handleConnection("user-1", "socket-1");
    await flush();

    const ownRoomEmits = emittedRooms.filter((e) => e.room === "user:user-1");
    expect(ownRoomEmits.length).toBeGreaterThan(0);
    expect(ownRoomEmits.some((e) => e.event === "USER_ONLINE")).toBe(true);
  });

  it("delivers a presence event to every user who has this user as a contact", async () => {
    await getFakeDb().collection("contacts").insertOne({
      ownerId: "watcher-1",
      contactId: "user-2",
      createdAt: new Date(),
    });
    await getFakeDb().collection("contacts").insertOne({
      ownerId: "watcher-2",
      contactId: "user-2",
      createdAt: new Date(),
    });

    await handleConnection("user-2", "socket-1");
    await flush();

    const watcherRooms = emittedRooms.filter((e) => e.event === "USER_ONLINE").map((e) => e.room);
    expect(watcherRooms).toContain("user:watcher-1");
    expect(watcherRooms).toContain("user:watcher-2");
    expect(watcherRooms).toContain("user:user-2");
  });

  it("does not deliver to a user who has NOT added the online user as a contact", async () => {
    await getFakeDb().collection("contacts").insertOne({
      ownerId: "stranger",
      contactId: "someone-else-entirely",
      createdAt: new Date(),
    });

    await handleConnection("user-3", "socket-1");
    await flush();

    expect(emittedRooms.some((e) => e.room === "user:stranger")).toBe(false);
  });

  it("never calls io.emit() globally — every delivery is room-scoped", async () => {
    await getFakeDb().collection("contacts").insertOne({
      ownerId: "watcher-3",
      contactId: "user-4",
      createdAt: new Date(),
    });

    await handleConnection("user-4", "socket-1");
    await flush();

    expect(globalEmits).toHaveLength(0);
  });
});
