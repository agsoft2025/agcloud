import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTimeout, SHUTDOWN_DRAIN_TIMEOUT_MS } from "../src/server.js";
import logger from "../src/shared/observability/logger.js";

describe("server graceful shutdown (spec §6.5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exports a 30s drain timeout, matching spec §6.5's max in-flight wait", () => {
    expect(SHUTDOWN_DRAIN_TIMEOUT_MS).toBe(30_000);
  });

  describe("withTimeout", () => {
    it("resolves once the wrapped promise resolves, well before the timeout", async () => {
      const promise = withTimeout(Promise.resolve("done"), 30_000, "test-step");
      await expect(promise).resolves.toBeUndefined();
    });

    it("resolves anyway (does not reject) once the timeout elapses, warning instead of hanging forever", async () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
      const neverResolves = new Promise(() => {});

      const promise = withTimeout(neverResolves, 30_000, "app.close");
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(promise).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ label: "app.close", ms: 30_000 }),
        "Graceful shutdown step timed out — proceeding anyway"
      );
    });

    it("resolves anyway (does not reject) when the wrapped promise rejects", async () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
      const promise = withTimeout(Promise.reject(new Error("close failed")), 30_000, "app.close");

      await expect(promise).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ label: "app.close" }),
        "Graceful shutdown step failed — proceeding anyway"
      );
    });
  });
});
