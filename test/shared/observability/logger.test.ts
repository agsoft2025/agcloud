import { describe, it, expect, vi, afterEach } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import logger, { pinoOptions } from "../../../src/shared/observability/logger.js";
import { enterRequestContext } from "../../../src/shared/observability/request-context.js";

// Real pino (as opposed to the old hand-rolled logger) writes directly to the
// stdout file descriptor via SonicBoom rather than calling
// `process.stdout.write`, so these tests assert against pino's own public
// introspection API (`.level`, `.isLevelEnabled()`, `.bindings()`) instead of
// spying on stdout/stderr writes.
describe("logger (default instance, LOG_LEVEL=fatal from test/setup.ts)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is configured at the fatal threshold from LOG_LEVEL", () => {
    expect(logger.level).toBe("fatal");
  });

  it("suppresses info/warn/error below the fatal threshold", () => {
    expect(logger.isLevelEnabled("info")).toBe(false);
    expect(logger.isLevelEnabled("warn")).toBe(false);
    expect(logger.isLevelEnabled("error")).toBe(false);
    expect(logger.isLevelEnabled("fatal")).toBe(true);
  });

  it("exposes the service/version/env base bindings", () => {
    const bindings = logger.bindings();
    expect(bindings.service).toBe("agcloud-backend");
    expect(bindings.env).toBe("test");
    expect(bindings.version).toBeTruthy();
  });

  it("exposes all levels used across the codebase as callable methods without throwing", () => {
    // Call-site shapes used throughout src/: logger.LEVEL(obj, msg) and logger.LEVEL(msg).
    expect(() => logger.trace({ a: 1 }, "trace")).not.toThrow();
    expect(() => logger.debug("debug msg")).not.toThrow();
    expect(() => logger.info({ a: 1 }, "info")).not.toThrow();
    expect(() => logger.warn("warn msg")).not.toThrow();
    expect(() => logger.error({ err: "x" }, "error")).not.toThrow();
    expect(() => logger.fatal("fatal msg")).not.toThrow();
  });

  it("child(bindings) returns a logger whose bindings() include both parent and child bindings", () => {
    const child = logger.child({ requestId: "req-123", module: "test" });
    const bindings = child.bindings();

    expect(bindings.requestId).toBe("req-123");
    expect(bindings.module).toBe("test");
    // parent bindings should still be present too
    expect(bindings.service).toBe("agcloud-backend");
  });

  it("a child logger's own level tracks the parent unless overridden", () => {
    const child = logger.child({ module: "test" });
    expect(child.level).toBe(logger.level);
  });
});

describe("logger level filtering (module-load-time configuredLevel)", () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    process.env.LOG_LEVEL = originalLogLevel;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("honours LOG_LEVEL=debug at module load time", async () => {
    process.env.LOG_LEVEL = "debug";
    vi.resetModules();
    const { default: freshLogger } = await import("../../../src/shared/observability/logger.js");

    expect(freshLogger.level).toBe("debug");
    expect(freshLogger.isLevelEnabled("debug")).toBe(true);
    expect(freshLogger.isLevelEnabled("trace")).toBe(false);
  });

  it("honours LOG_LEVEL=info at module load time, still suppressing debug/trace", async () => {
    process.env.LOG_LEVEL = "info";
    vi.resetModules();
    const { default: freshLogger } = await import("../../../src/shared/observability/logger.js");

    expect(freshLogger.level).toBe("info");
    expect(freshLogger.isLevelEnabled("info")).toBe(true);
    expect(freshLogger.isLevelEnabled("debug")).toBe(false);
    expect(freshLogger.isLevelEnabled("trace")).toBe(false);
  });

  it("honours LOG_LEVEL=error at module load time", async () => {
    process.env.LOG_LEVEL = "error";
    vi.resetModules();
    const { default: freshLogger } = await import("../../../src/shared/observability/logger.js");

    expect(freshLogger.level).toBe("error");
    expect(freshLogger.isLevelEnabled("error")).toBe(true);
    expect(freshLogger.isLevelEnabled("warn")).toBe(false);
  });
});

describe("logger output (spec §7.1: redaction + request correlation)", () => {
  // pino writes via SonicBoom, not process.stdout.write, so the only
  // reliable way to assert on actual serialized output is to build a real
  // pino instance — using the exact same options the app uses — against an
  // in-memory Writable instead of the default stdout destination.
  function captureLogger(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    return {
      logger: pino({ ...pinoOptions, level: "info" }, stream),
      lines: () => chunks.map((c) => JSON.parse(c)),
    };
  }

  it("redacts req.headers.authorization, req.body.password, and user.email", () => {
    const { logger: testLogger, lines } = captureLogger();

    testLogger.info(
      {
        req: { headers: { authorization: "Bearer secret-token" }, body: { password: "hunter2" } },
        user: { email: "person@example.com" },
      },
      "test event"
    );

    const [line] = lines();
    expect(line.req).toMatchObject({
      headers: { authorization: "[REDACTED]" },
      body: { password: "[REDACTED]" },
    });
    expect(line.user).toMatchObject({ email: "[REDACTED]" });
  });

  it("mixes the active requestId/userId from AsyncLocalStorage into every log line", async () => {
    const { logger: testLogger, lines } = captureLogger();

    await new Promise<void>((resolve) => {
      enterRequestContext({ requestId: "req-abc", userId: "user-xyz" });
      queueMicrotask(() => {
        testLogger.info("inside request");
        resolve();
      });
    });

    const [line] = lines();
    expect(line.requestId).toBe("req-abc");
    expect(line.userId).toBe("user-xyz");
  });

  it("omits requestId/userId/traceId/spanId entirely when logging outside any request context", () => {
    const { logger: testLogger, lines } = captureLogger();
    testLogger.info("no context here");

    const [line] = lines();
    expect(line.requestId).toBeUndefined();
    expect(line.userId).toBeUndefined();
    expect(line.traceId).toBeUndefined();
    expect(line.spanId).toBeUndefined();
  });
});
