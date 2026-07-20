import { describe, it, expect, vi, afterEach } from "vitest";
import logger from "../../../src/shared/observability/logger.js";

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

  it("exposes the service/env base bindings", () => {
    const bindings = logger.bindings();
    expect(bindings.service).toBe("agcloud-backend");
    expect(bindings.env).toBe("test");
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
