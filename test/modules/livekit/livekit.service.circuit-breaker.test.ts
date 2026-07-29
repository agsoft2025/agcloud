import { describe, it, expect, beforeEach, vi } from "vitest";
import "../../helpers/mockLivekit.js";
import { livekitMocks } from "../../helpers/mockLivekit.js";
import logger from "../../../src/shared/observability/logger.js";

/**
 * livekit.service.ts wraps every LiveKit network call (deleteRoom,
 * egress start/stop, health check) in a CircuitBreaker so a LiveKit outage
 * degrades gracefully instead of hanging every call-related request. This
 * lives in its own file (with vi.resetModules() per test) because the
 * breaker is a module-level singleton — tripping it here must not leak into
 * livekit.service.test.ts's assumption that calls succeed by default.
 */
describe("livekit.service — circuit breaker wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    livekitMocks.listRooms.mockReset();
  });

  it("trips open after repeated failures and short-circuits further calls without hitting the client", async () => {
    const { checkLiveKitHealth } = await import("../../../src/modules/livekit/livekit.service.js");

    livekitMocks.listRooms.mockRejectedValue(new Error("LiveKit unreachable"));
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);

    // failureThreshold is 5 — five failures should trip the breaker to OPEN.
    for (let i = 0; i < 5; i++) {
      expect(await checkLiveKitHealth()).toBe(false);
    }
    expect(livekitMocks.listRooms).toHaveBeenCalledTimes(5);

    // The 6th call should be rejected by the breaker itself (OPEN state) —
    // the underlying client must not be invoked again.
    expect(await checkLiveKitHealth()).toBe(false);
    expect(livekitMocks.listRooms).toHaveBeenCalledTimes(5);

    errorSpy.mockRestore();
  });

  it("recovering (listRooms succeeding again) does not matter while still OPEN — stays short-circuited", async () => {
    const { checkLiveKitHealth } = await import("../../../src/modules/livekit/livekit.service.js");
    vi.spyOn(logger, "error").mockImplementation(() => logger);

    livekitMocks.listRooms.mockRejectedValue(new Error("LiveKit unreachable"));
    for (let i = 0; i < 5; i++) {
      await checkLiveKitHealth();
    }

    // Even though the dependency has recovered, the breaker is still OPEN
    // (openDurationMs hasn't elapsed) and must not call through yet.
    livekitMocks.listRooms.mockResolvedValue([]);
    await checkLiveKitHealth();
    expect(livekitMocks.listRooms).toHaveBeenCalledTimes(5);
  });

  it("a healthy dependency never trips the breaker", async () => {
    const { checkLiveKitHealth } = await import("../../../src/modules/livekit/livekit.service.js");
    livekitMocks.listRooms.mockResolvedValue([]);

    for (let i = 0; i < 10; i++) {
      expect(await checkLiveKitHealth()).toBe(true);
    }
    expect(livekitMocks.listRooms).toHaveBeenCalledTimes(10);
  });
});
