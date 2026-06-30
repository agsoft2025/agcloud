import logger from "../observability/logger.js";

type State = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number;   // failures before opening (default 5)
  successThreshold?: number;   // successes in HALF_OPEN to close (default 2)
  openDurationMs?: number;     // how long to stay OPEN before trying HALF_OPEN (default 30s)
  timeout?: number;            // per-call timeout in ms (default: none)
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

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.openDurationMs = options.openDurationMs ?? 30_000;
    this.timeout = options.timeout;
  }

  /** Execute `fn` through the circuit breaker. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.transitionIfNeeded();

    if (this.state === "OPEN") {
      throw new Error(`Circuit breaker [${this.name}] is OPEN — request rejected`);
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
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === "HALF_OPEN") {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = "CLOSED";
        logger.info({ breaker: this.name }, "Circuit breaker → CLOSED");
      }
    }
  }

  private onFailure(err: unknown): void {
    this.failureCount++;
    if (this.state === "HALF_OPEN" || this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
      this.lastOpenedAt = Date.now();
      logger.warn({ breaker: this.name, failures: this.failureCount, err }, "Circuit breaker → OPEN");
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
