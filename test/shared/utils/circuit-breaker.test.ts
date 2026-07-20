import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker } from "../../../src/shared/utils/circuit-breaker.js";

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays CLOSED while calls succeed", async () => {
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 3 });
    for (let i = 0; i < 10; i++) {
      const result = await breaker.execute(async () => "ok");
      expect(result).toBe("ok");
    }
    expect(breaker.currentState).toBe("CLOSED");
  });

  it("opens after failureThreshold consecutive failures", async () => {
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 3 });
    const failingFn = vi.fn().mockRejectedValue(new Error("boom"));

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failingFn)).rejects.toThrow("boom");
    }

    expect(breaker.currentState).toBe("OPEN");
    expect(failingFn).toHaveBeenCalledTimes(3);
  });

  it("rejects immediately without calling fn again once OPEN", async () => {
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 2 });
    const failingFn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(breaker.execute(failingFn)).rejects.toThrow("boom");
    await expect(breaker.execute(failingFn)).rejects.toThrow("boom");
    expect(breaker.currentState).toBe("OPEN");
    expect(failingFn).toHaveBeenCalledTimes(2);

    const neverCalled = vi.fn().mockResolvedValue("should not run");
    await expect(breaker.execute(neverCalled)).rejects.toThrow(/is OPEN/);
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it("transitions to HALF_OPEN after openDurationMs elapses", async () => {
    const breaker = new CircuitBreaker({
      name: "test",
      failureThreshold: 1,
      openDurationMs: 1000,
    });
    const failingFn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(breaker.execute(failingFn)).rejects.toThrow("boom");
    expect(breaker.currentState).toBe("OPEN");

    vi.advanceTimersByTime(999);
    expect(breaker.currentState).toBe("OPEN");

    vi.advanceTimersByTime(2);
    expect(breaker.currentState).toBe("HALF_OPEN");
  });

  it("closes again after successThreshold successes in HALF_OPEN", async () => {
    const breaker = new CircuitBreaker({
      name: "test",
      failureThreshold: 1,
      successThreshold: 2,
      openDurationMs: 1000,
    });

    await expect(breaker.execute(async () => { throw new Error("boom"); })).rejects.toThrow();
    expect(breaker.currentState).toBe("OPEN");

    vi.advanceTimersByTime(1000);
    expect(breaker.currentState).toBe("HALF_OPEN");

    await breaker.execute(async () => "ok-1");
    expect(breaker.currentState).toBe("HALF_OPEN");

    await breaker.execute(async () => "ok-2");
    expect(breaker.currentState).toBe("CLOSED");
  });

  it("re-opens on a failure while HALF_OPEN", async () => {
    const breaker = new CircuitBreaker({
      name: "test",
      failureThreshold: 1,
      successThreshold: 2,
      openDurationMs: 1000,
    });

    await expect(breaker.execute(async () => { throw new Error("boom"); })).rejects.toThrow();
    expect(breaker.currentState).toBe("OPEN");

    vi.advanceTimersByTime(1000);
    expect(breaker.currentState).toBe("HALF_OPEN");

    await expect(
      breaker.execute(async () => { throw new Error("boom again"); })
    ).rejects.toThrow("boom again");

    expect(breaker.currentState).toBe("OPEN");
  });

  it("resolves normally when fn completes within the timeout", async () => {
    const breaker = new CircuitBreaker({ name: "timeout-ok", timeout: 1000 });
    const result = await breaker.execute(() => Promise.resolve("fast"));
    expect(result).toBe("fast");
    expect(breaker.currentState).toBe("CLOSED");
  });

  it("propagates fn's own rejection (not a timeout error) when it fails before the timeout elapses", async () => {
    const breaker = new CircuitBreaker({ name: "timeout-own-failure", timeout: 1000, failureThreshold: 5 });
    await expect(breaker.execute(() => Promise.reject(new Error("underlying failure")))).rejects.toThrow(
      "underlying failure"
    );
  });

  it("rejects with a timeout error when fn exceeds the configured timeout", async () => {
    const breaker = new CircuitBreaker({ name: "timeout-fail", timeout: 1000, failureThreshold: 5 });
    const slow = () => new Promise((resolve) => setTimeout(() => resolve("too-late"), 5000));

    const pending = expect(breaker.execute(slow)).rejects.toThrow(/timed out after 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
  });

  it("uses the default thresholds when options are omitted", async () => {
    const breaker = new CircuitBreaker({ name: "defaults" });
    const failingFn = vi.fn().mockRejectedValue(new Error("boom"));

    for (let i = 0; i < 4; i++) {
      await expect(breaker.execute(failingFn)).rejects.toThrow();
      expect(breaker.currentState).toBe("CLOSED");
    }

    await expect(breaker.execute(failingFn)).rejects.toThrow();
    expect(breaker.currentState).toBe("OPEN");
    expect(failingFn).toHaveBeenCalledTimes(5);
  });
});
