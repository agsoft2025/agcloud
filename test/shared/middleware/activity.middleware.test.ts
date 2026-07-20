import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetFakes } from "../../helpers/mockDb.js";
import { activityMiddleware } from "../../../src/shared/middleware/activity.middleware.js";
import * as presenceService from "../../../src/modules/presence/presence.service.js";

describe("activityMiddleware", () => {
  beforeEach(() => resetFakes());
  afterEach(() => vi.restoreAllMocks());

  it("is a no-op when the request has no authenticated user", async () => {
    const activitySpy = vi.spyOn(presenceService, "handleActivity");
    await activityMiddleware({ user: undefined } as any, {} as any);
    expect(activitySpy).not.toHaveBeenCalled();
  });

  it("fires handleActivity for the authenticated user without delaying the response", async () => {
    const activitySpy = vi.spyOn(presenceService, "handleActivity").mockResolvedValue(undefined);
    await activityMiddleware({ user: { userId: "user-1", email: "u1@example.com" } } as any, {} as any);
    expect(activitySpy).toHaveBeenCalledWith("user-1");
  });

  it("swallows and logs a handleActivity failure instead of throwing", async () => {
    vi.spyOn(presenceService, "handleActivity").mockRejectedValue(new Error("redis down"));

    await expect(
      activityMiddleware({ user: { userId: "user-2", email: "u2@example.com" } } as any, {} as any)
    ).resolves.toBeUndefined();

    // Flush the fire-and-forget rejection handler.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
