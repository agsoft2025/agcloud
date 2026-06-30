import { describe, expect, it } from "vitest";
import { isAllowedCorsOrigin } from "../src/shared/security/cors.js";

describe("CORS origin allowlist", () => {
  it("allows the local Vite frontend origin", () => {
    expect(isAllowedCorsOrigin("http://localhost:5173")).toBe(true);
  });

  it("allows devtunnel origins during local development", () => {
    expect(isAllowedCorsOrigin("https://example-5173.inc1.devtunnels.ms")).toBe(true);
  });

  it("rejects unconfigured public origins", () => {
    expect(isAllowedCorsOrigin("https://example.com")).toBe(false);
  });
});
