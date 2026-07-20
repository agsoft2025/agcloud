import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fastifyCorsOriginCallback,
  socketCorsOriginCallback,
} from "../../../src/shared/security/cors.js";

describe("fastifyCorsOriginCallback", () => {
  it("invokes callback with (null, true) for an allowed origin (falls back to `true` for the boolean-only path when origin itself would be returned)", () => {
    const callback = vi.fn();
    fastifyCorsOriginCallback("http://localhost:5173", callback);
    expect(callback).toHaveBeenCalledTimes(1);
    const [err, allow] = callback.mock.calls[0];
    expect(err).toBeNull();
    // implementation returns the origin string itself (truthy) when allowed
    expect(allow).toBe("http://localhost:5173");
  });

  it("invokes callback with (null, false) for a disallowed origin", () => {
    const callback = vi.fn();
    fastifyCorsOriginCallback("https://evil.example.com", callback);
    expect(callback).toHaveBeenCalledWith(null, false);
  });

  it("allows an undefined origin (non-browser / same-origin requests)", () => {
    const callback = vi.fn();
    fastifyCorsOriginCallback(undefined, callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it("allows an empty-string origin (isAllowedCorsOrigin treats it as absent, but `origin ?? true` preserves the empty string itself)", () => {
    const callback = vi.fn();
    fastifyCorsOriginCallback("", callback);
    expect(callback).toHaveBeenCalledWith(null, "");
  });

  it("disallows a malformed (non-parseable) origin string", () => {
    const callback = vi.fn();
    fastifyCorsOriginCallback("not-a-valid-url", callback);
    expect(callback).toHaveBeenCalledWith(null, false);
  });
});

describe("socketCorsOriginCallback", () => {
  it("invokes callback with (null, true) for an allowed origin", () => {
    const callback = vi.fn();
    socketCorsOriginCallback("http://localhost:5173", callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it("invokes callback with (null, false) for a disallowed origin", () => {
    const callback = vi.fn();
    socketCorsOriginCallback("https://evil.example.com", callback);
    expect(callback).toHaveBeenCalledWith(null, false);
  });

  it("allows an undefined origin", () => {
    const callback = vi.fn();
    socketCorsOriginCallback(undefined, callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });
});

describe("devtunnel gating on environment", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.resetModules();
  });

  it("allows devtunnel origins in non-production (test) env", async () => {
    process.env.NODE_ENV = "test";
    vi.resetModules();
    const mod = await import("../../../src/shared/security/cors.js");
    const callback = vi.fn();
    mod.socketCorsOriginCallback("https://example-5173.inc1.devtunnels.ms", callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it("rejects devtunnel origins in production env", async () => {
    process.env.NODE_ENV = "production";
    vi.resetModules();
    const mod = await import("../../../src/shared/security/cors.js");
    const callback = vi.fn();
    mod.socketCorsOriginCallback("https://example-5173.inc1.devtunnels.ms", callback);
    expect(callback).toHaveBeenCalledWith(null, false);
  });
});
