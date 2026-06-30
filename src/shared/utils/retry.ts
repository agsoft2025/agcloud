import logger from "../observability/logger.js";

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;          // exponential backoff multiplier
  retryOn?: (err: unknown) => boolean; // custom predicate — defaults to always retry
}

/**
 * Execute `fn` with exponential backoff retry.
 *
 * @example
 *   const result = await withRetry(() => fetchSomething(), { maxAttempts: 3 });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 100,
    maxDelayMs = 5000,
    factor = 2,
    retryOn = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === maxAttempts || !retryOn(err)) {
        throw err;
      }

      const jitter = Math.random() * 0.3 + 0.85; // ±15% jitter
      const delay = Math.min(initialDelayMs * factor ** (attempt - 1) * jitter, maxDelayMs);

      logger.warn(
        { attempt, maxAttempts, delayMs: Math.round(delay), err },
        "Retrying after error"
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
