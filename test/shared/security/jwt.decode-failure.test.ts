import { describe, it, expect, vi } from "vitest";

vi.mock("jsonwebtoken", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jsonwebtoken")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      decode: () => {
        throw new Error("decode blew up");
      },
    },
  };
});

describe("decodeAccessTokenUnsafe (jwt.decode throws)", () => {
  it("returns null instead of propagating the exception", async () => {
    const { decodeAccessTokenUnsafe } = await import("../../../src/shared/security/jwt.js");
    expect(decodeAccessTokenUnsafe("anything")).toBeNull();
  });
});
