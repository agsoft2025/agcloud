import { EventEmitter } from "node:events";

/**
 * Minimal in-memory ioredis stand-in covering only the commands this codebase
 * actually calls (see presence.repository.ts, auth.middleware.ts,
 * idempotency.ts, health.routes.ts). Not a general-purpose Redis emulator.
 */
type PipelineOp = { cmd: string; args: unknown[] };

export class FakeRedis extends EventEmitter {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  sets = new Map<string, Set<string>>();
  expirations = new Map<string, number>();
  published: { channel: string; message: string }[] = [];

  private notExpired(key: string): boolean {
    const exp = this.expirations.get(key);
    if (exp === undefined) return true;
    if (Date.now() < exp) return true;
    this.strings.delete(key);
    this.hashes.delete(key);
    this.sets.delete(key);
    this.expirations.delete(key);
    return false;
  }

  async get(key: string): Promise<string | null> {
    if (!this.notExpired(key)) return null;
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string, ...rest: unknown[]): Promise<"OK" | null> {
    // NX ("set if not exists") — checked before writing, and against
    // notExpired() so an expired key is treated as absent, matching real
    // Redis TTL semantics.
    if (rest.includes("NX") && this.notExpired(key) && this.strings.has(key)) {
      return null;
    }

    this.strings.set(key, value);
    const exIndex = rest.findIndex((r) => r === "EX");
    if (exIndex !== -1) {
      const seconds = Number(rest[exIndex + 1]);
      this.expirations.set(key, Date.now() + seconds * 1000);
    } else {
      this.expirations.delete(key);
    }
    return "OK";
  }

  async setex(key: string, seconds: number, value: string): Promise<"OK"> {
    return this.set(key, value, "EX", seconds);
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) count++;
      if (this.hashes.delete(key)) count++;
      if (this.sets.delete(key)) count++;
      this.expirations.delete(key);
    }
    return count;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.strings.has(key) && !this.hashes.has(key) && !this.sets.has(key)) return 0;
    this.expirations.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  /** Increments without touching any existing TTL, matching real INCR semantics. */
  async incr(key: string): Promise<number> {
    const current = (this.notExpired(key) ? Number(this.strings.get(key) ?? "0") : 0) + 1;
    this.strings.set(key, String(current));
    return current;
  }

  async pttl(key: string): Promise<number> {
    if (!this.notExpired(key)) return -2;
    const exp = this.expirations.get(key);
    if (exp === undefined) {
      return this.strings.has(key) || this.hashes.has(key) || this.sets.has(key) ? -1 : -2;
    }
    return Math.max(exp - Date.now(), 0);
  }

  pexpire(
    key: string,
    ms: number,
    cb?: (err: Error | null, res?: number) => void
  ): Promise<number> | void {
    const run = async () => {
      if (!this.strings.has(key) && !this.hashes.has(key) && !this.sets.has(key)) return 0;
      this.expirations.set(key, Date.now() + ms);
      return 1;
    };
    if (typeof cb === "function") {
      run().then((r) => cb(null, r)).catch((e) => cb(e as Error));
      return;
    }
    return run();
  }

  async exists(key: string): Promise<number> {
    return this.notExpired(key) &&
      (this.strings.has(key) || this.hashes.has(key) || this.sets.has(key))
      ? 1
      : 0;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    if (!this.notExpired(key)) return {};
    const map = this.hashes.get(key);
    return map ? Object.fromEntries(map) : {};
  }

  async hset(key: string, fields: Record<string, string>): Promise<number> {
    let map = this.hashes.get(key);
    if (!map) {
      map = new Map();
      this.hashes.set(key, map);
    }
    let added = 0;
    for (const [field, value] of Object.entries(fields)) {
      if (!map.has(field)) added++;
      map.set(field, String(value));
    }
    return added;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
      this.sets.set(key, set);
    }
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        added++;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed++;
    }
    return removed;
  }

  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? []);
  }

  async scan(_cursor: string, ..._args: unknown[]): Promise<[string, string[]]> {
    // Args are always ["MATCH", pattern, "COUNT", n] in this codebase.
    const pattern = String(_args[1] ?? "*");
    const regex = new RegExp("^" + pattern.split("*").map(escapeRegex).join(".*") + "$");
    const allKeys = [
      ...this.strings.keys(),
      ...this.hashes.keys(),
      ...this.sets.keys(),
    ];
    const matched = allKeys.filter((k) => regex.test(k));
    // Single-pass fake: always returns everything on cursor "0" and terminates.
    return ["0", matched];
  }

  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    this.emit("message", channel, message);
    return 1;
  }

  /**
   * No-op subscribe: since duplicate() returns the same instance, a
   * subscriber's `.on("message", ...)` listener (registered directly on this
   * EventEmitter) already receives everything publish() emits — there's no
   * separate channel-routing to simulate.
   */
  async subscribe(
    _channel: string,
    cb?: (err: Error | null, count?: number) => void
  ): Promise<number> {
    cb?.(null, 1);
    return 1;
  }

  async ping(): Promise<"PONG"> {
    return "PONG";
  }

  async quit(): Promise<"OK"> {
    return "OK";
  }

  duplicate(): FakeRedis {
    // presence.service.ts uses a duplicate connection for pub/sub subscription;
    // sharing the same in-memory store/event bus is sufficient for tests.
    return this;
  }

  pipeline() {
    const ops: PipelineOp[] = [];
    const pipelineCommands = ["del", "scard", "hgetall", "incr", "pttl", "pexpire", "set", "get", "sadd", "srem"];
    const chain: Record<string, unknown> = {
      exec: (cb?: (err: Error | null, results: [Error | null, unknown][]) => void) => {
        const run = async () => {
          const results: [Error | null, unknown][] = [];
          for (const op of ops) {
            try {
              const fn = (this as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[op.cmd];
              const value = await fn.apply(this, op.args);
              results.push([null, value]);
            } catch (err) {
              results.push([err as Error, null]);
            }
          }
          return results;
        };
        if (typeof cb === "function") {
          run().then((results) => cb(null, results)).catch((err) => cb(err as Error, []));
          return;
        }
        return run();
      },
    };
    for (const cmd of pipelineCommands) {
      chain[cmd] = (...args: unknown[]) => {
        ops.push({ cmd, args });
        return chain;
      };
    }
    return chain as unknown as {
      del: (key: string) => typeof chain;
      scard: (key: string) => typeof chain;
      hgetall: (key: string) => typeof chain;
      incr: (key: string) => typeof chain;
      pttl: (key: string) => typeof chain;
      pexpire: (key: string, ms: number) => typeof chain;
      exec: {
        (): Promise<[Error | null, unknown][]>;
        (cb: (err: Error | null, results: [Error | null, unknown][]) => void): void;
      };
    };
  }
}

function escapeRegex(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createFakeRedis(): FakeRedis {
  return new FakeRedis();
}
