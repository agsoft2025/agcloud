import { describe, it, expect, vi, afterEach } from "vitest";

describe("config", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("falls back jwtRefreshSecret to jwtSecret when JWT_REFRESH_SECRET is unset", async () => {
    const original = process.env.JWT_REFRESH_SECRET;
    delete process.env.JWT_REFRESH_SECRET;

    const { default: config } = await import("../../src/config/index.js");
    expect(config.jwtRefreshSecret).toBe(config.jwtSecret);

    if (original !== undefined) process.env.JWT_REFRESH_SECRET = original;
  });

  it("uses JWT_REFRESH_SECRET when explicitly set and different from JWT_SECRET", async () => {
    const original = process.env.JWT_REFRESH_SECRET;
    process.env.JWT_REFRESH_SECRET = "a_distinct_refresh_secret_at_least_32_chars_long__";

    const { default: config } = await import("../../src/config/index.js");
    expect(config.jwtRefreshSecret).toBe("a_distinct_refresh_secret_at_least_32_chars_long__");
    expect(config.jwtRefreshSecret).not.toBe(config.jwtSecret);

    if (original !== undefined) process.env.JWT_REFRESH_SECRET = original;
    else delete process.env.JWT_REFRESH_SECRET;
  });
});
