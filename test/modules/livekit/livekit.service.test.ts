import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../../helpers/mockLivekit.js";
import { livekitMocks } from "../../helpers/mockLivekit.js";
import {
  startRoomRecording,
  stopRecording,
  endLiveKitRoom,
  createLiveKitToken,
  checkLiveKitHealth,
  getLiveKitPublicUrl,
  getLiveKitBaseUrl,
} from "../../../src/modules/livekit/livekit.service.js";

describe("livekit.service", () => {
  beforeEach(() => {
    livekitMocks.deleteRoom.mockReset().mockResolvedValue(undefined);
    livekitMocks.listRooms.mockReset().mockResolvedValue([]);
    livekitMocks.startRoomCompositeEgress.mockReset().mockResolvedValue({ egressId: "egress-123" });
    livekitMocks.stopEgress.mockReset().mockResolvedValue({ egressId: "egress-123" });
    livekitMocks.toJwt.mockReset().mockResolvedValue("fake.livekit.jwt");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("startRoomRecording delegates to the egress client", async () => {
    const result = await startRoomRecording("room-1", { filepath: "/tmp/x.mp4" });
    expect(result).toEqual({ egressId: "egress-123" });
    expect(livekitMocks.startRoomCompositeEgress).toHaveBeenCalledWith("room-1", { filepath: "/tmp/x.mp4" }, {});
  });

  it("stopRecording delegates to the egress client", async () => {
    const result = await stopRecording("egress-123");
    expect(result).toEqual({ egressId: "egress-123" });
    expect(livekitMocks.stopEgress).toHaveBeenCalledWith("egress-123");
  });

  it("endLiveKitRoom deletes the room", async () => {
    await endLiveKitRoom("room-1");
    expect(livekitMocks.deleteRoom).toHaveBeenCalledWith("room-1");
  });

  it("endLiveKitRoom swallows a delete failure and warns instead of throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    livekitMocks.deleteRoom.mockRejectedValueOnce(new Error("room not found"));

    await expect(endLiveKitRoom("missing-room")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("createLiveKitToken returns a signed JWT", async () => {
    const token = await createLiveKitToken("user-1", "room-1");
    expect(token).toBe("fake.livekit.jwt");
  });

  it("checkLiveKitHealth returns true when listRooms succeeds", async () => {
    expect(await checkLiveKitHealth()).toBe(true);
  });

  it("checkLiveKitHealth returns false and logs when listRooms fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    livekitMocks.listRooms.mockRejectedValueOnce(new Error("unreachable"));

    expect(await checkLiveKitHealth()).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("getLiveKitPublicUrl / getLiveKitBaseUrl return a URL string", () => {
    expect(typeof getLiveKitPublicUrl()).toBe("string");
    expect(getLiveKitBaseUrl()).toBe(getLiveKitPublicUrl());
  });
});
