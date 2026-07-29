import { describe, it, expect } from "vitest";
import {
  enterRequestContext,
  setRequestContextField,
  getRequestContext,
} from "../../../src/shared/observability/request-context.js";

describe("request-context", () => {
  it("returns undefined outside of any entered context", () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it("enterRequestContext makes the context visible for the rest of the async chain", async () => {
    await new Promise<void>((resolve) => {
      enterRequestContext({ requestId: "req-1" });
      queueMicrotask(() => {
        expect(getRequestContext()).toEqual({ requestId: "req-1" });
        resolve();
      });
    });
  });

  it("setRequestContextField mutates the active context in place", async () => {
    await new Promise<void>((resolve) => {
      enterRequestContext({ requestId: "req-2" });
      setRequestContextField("userId", "user-2");
      queueMicrotask(() => {
        expect(getRequestContext()).toEqual({ requestId: "req-2", userId: "user-2" });
        resolve();
      });
    });
  });

  it("setRequestContextField is a no-op when no context is active", () => {
    expect(() => setRequestContextField("userId", "user-x")).not.toThrow();
    expect(getRequestContext()).toBeUndefined();
  });

  it("isolates concurrent contexts from each other", async () => {
    async function run(requestId: string) {
      enterRequestContext({ requestId });
      await new Promise((r) => setTimeout(r, Math.random() * 10));
      return getRequestContext();
    }

    const [a, b] = await Promise.all([run("req-a"), run("req-b")]);
    expect(a).toEqual({ requestId: "req-a" });
    expect(b).toEqual({ requestId: "req-b" });
  });
});
