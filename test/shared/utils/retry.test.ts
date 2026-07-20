import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "../../../src/shared/utils/retry.js";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds immediately when fn succeeds on the first try (no delay/retry)", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await withRetry(fn);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds if fn succeeds on a later attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockResolvedValueOnce("recovered");

    const promise = withRetry(fn, { maxAttempts: 5, initialDelayMs: 10 });
    // Flush the sleeps between retry attempts.
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries up to maxAttempts then throws the last error", async () => {
    const err = new Error("always fails");
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withRetry(fn, { maxAttempts: 3, initialDelayMs: 10 });
    const assertion = expect(promise).rejects.toThrow("always fails");

    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects the retryOn predicate and stops retrying when it returns false", async () => {
    class NonRetryableError extends Error {}
    const err = new NonRetryableError("do not retry me");
    const fn = vi.fn().mockRejectedValue(err);
    const retryOn = vi.fn((e: unknown) => !(e instanceof NonRetryableError));

    const promise = withRetry(fn, { maxAttempts: 5, initialDelayMs: 10, retryOn });
    const assertion = expect(promise).rejects.toThrow("do not retry me");

    await vi.runAllTimersAsync();
    await assertion;

    // Should stop after the first failure since retryOn returns false.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws immediately without calling fn when maxAttempts is 0", async () => {
    const fn = vi.fn();
    await expect(withRetry(fn, { maxAttempts: 0 })).rejects.toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it("calls fn again when retryOn returns true", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("retryable"))
      .mockResolvedValueOnce("ok");
    const retryOn = vi.fn().mockReturnValue(true);

    const promise = withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, retryOn });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(retryOn).toHaveBeenCalledTimes(1);
  });
});
