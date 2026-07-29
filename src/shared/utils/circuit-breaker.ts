import logger from "../observability/logger.js";

type State = "CLOSED" | "OPEN" | "HALF_OPEN";

/** Thrown by `execute()` when the breaker is OPEN — callers can distinguish a fast-fail from a real error (e.g. to reroute to a fallback queue). */
export class CircuitOpenError extends Error {}

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number;   // failures before opening (default 5)
  successThreshold?: number;   // successes in HALF_OPEN to close (default 2)
  openDurationMs?: number;     // how long to stay OPEN before trying HALF_OPEN (default 30s)
  timeout?: number;            // per-call timeout in ms (default: none)
  /** Called on every state transition (and once at construction with the initial CLOSED state) — wire to a metrics gauge without this generic utility depending on prom-client directly. */
  onStateChange?: (state: State) => void;
}

export class CircuitBreaker {
  private state: State = "CLOSED";
  private failureCount = 0;
  private successCount = 0;
  private lastOpenedAt: number | null = null;

  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly openDurationMs: number;
  private readonly timeout: number | undefined;
  private readonly onStateChange: ((state: State) => void) | undefined;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.openDurationMs = options.openDurationMs ?? 30_000;
    this.timeout = options.timeout;
    this.onStateChange = options.onStateChange;
    this.onStateChange?.(this.state);
  }

  /** Execute `fn` through the circuit breaker. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.transitionIfNeeded();

    if (this.state === "OPEN") {
      throw new CircuitOpenError(`Circuit breaker [${this.name}] is OPEN — request rejected`);
    }

    try {
      const result = this.timeout
        ? await this.withTimeout(fn(), this.timeout)
        : await fn();

      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  get currentState(): State {
    this.transitionIfNeeded();
    return this.state;
  }

  private transitionIfNeeded(): void {
    if (
      this.state === "OPEN" &&
      this.lastOpenedAt !== null &&
      Date.now() - this.lastOpenedAt >= this.openDurationMs
    ) {
      this.state = "HALF_OPEN";
      this.successCount = 0;
      logger.info({ breaker: this.name }, "Circuit breaker → HALF_OPEN");
      this.onStateChange?.(this.state);
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === "HALF_OPEN") {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = "CLOSED";
        logger.info({ breaker: this.name }, "Circuit breaker → CLOSED");
        this.onStateChange?.(this.state);
      }
    }
  }

  private onFailure(err: unknown): void {
    this.failureCount++;
    if (this.state === "HALF_OPEN" || this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
      this.lastOpenedAt = Date.now();
      logger.warn({ breaker: this.name, failures: this.failureCount, err }, "Circuit breaker → OPEN");
      this.onStateChange?.(this.state);
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Circuit breaker [${this.name}] timed out after ${ms}ms`)),
        ms
      );
      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }
}
