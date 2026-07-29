import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

describe("fcm.client", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn());
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("FCM_")) delete process.env[key];
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("skips and returns { ok: false } when FCM_PROJECT_ID is not configured", async () => {
    const { sendFcmNotification } = await import("../../../src/modules/notification/fcm.client.js");
    const result = await sendFcmNotification({ token: "tok-1", title: "Hi", body: "there" });
    expect(result).toEqual({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  describe("when configured", () => {
    beforeEach(() => {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
      process.env.FCM_PROJECT_ID = "my-project";
      process.env.FCM_CLIENT_EMAIL = "svc@my-project.iam.gserviceaccount.com";
      process.env.FCM_PRIVATE_KEY = pem;
    });

    it("returns { ok: true } when the OAuth exchange and send both succeed", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "at-1", expires_in: 3600 }),
        })
        .mockResolvedValueOnce({ ok: true });

      const { sendFcmNotification } = await import("../../../src/modules/notification/fcm.client.js");
      const result = await sendFcmNotification({ token: "tok-1", title: "Hi", body: "there" });
      expect(result).toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(2);
      const [sendUrl, sendOpts] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(sendUrl).toContain("my-project");
      expect(sendOpts.headers.Authorization).toBe("Bearer at-1");
    });

    it("retries a transient send failure and eventually succeeds", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "at-1", expires_in: 3600 }) })
        // First send attempt: transient 500 (no FCM error.status, so treated as retryable)
        .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
        // Second send attempt succeeds
        .mockResolvedValueOnce({ ok: true });

      const { sendFcmNotification } = await import("../../../src/modules/notification/fcm.client.js");
      const result = await sendFcmNotification({ token: "tok-1", title: "Hi", body: "there" });
      expect(result).toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("does not retry and reports permanentFailure on FCM UNREGISTERED", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "at-1", expires_in: 3600 }) })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: async () => ({ error: { status: "UNREGISTERED" } }),
        });

      const { sendFcmNotification } = await import("../../../src/modules/notification/fcm.client.js");
      const result = await sendFcmNotification({ token: "tok-1", title: "Hi", body: "there" });
      expect(result).toEqual({ ok: false, permanentFailure: true });
      // 1 auth call + exactly 1 send attempt (no retries for a permanent error)
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("returns { ok: false } (no permanentFailure) after exhausting retries on repeated failure", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      });
      // First call is the OAuth exchange, which must succeed for send attempts to be reached.
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "at-1", expires_in: 3600 }),
      });

      const { sendFcmNotification } = await import("../../../src/modules/notification/fcm.client.js");
      const result = await sendFcmNotification({ token: "tok-1", title: "Hi", body: "there" });
      expect(result).toEqual({ ok: false });
    });

    it("opens the circuit breaker after repeated failures and fast-fails with circuitOpen", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "at-1", expires_in: 3600 }) })
        .mockResolvedValue({
          ok: false,
          status: 404,
          json: async () => ({ error: { status: "UNREGISTERED" } }),
        });

      const { sendFcmNotification } = await import("../../../src/modules/notification/fcm.client.js");

      // failureThreshold: 5 — each of these is a single-attempt permanent
      // failure (no retry), so this stays fast.
      for (let i = 0; i < 5; i++) {
        const result = await sendFcmNotification({ token: `tok-${i}`, title: "Hi", body: "there" });
        expect(result).toEqual({ ok: false, permanentFailure: true });
      }

      const callsBeforeOpen = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

      const result = await sendFcmNotification({ token: "tok-blocked", title: "Hi", body: "there" });
      expect(result).toEqual({ ok: false, circuitOpen: true });
      // Breaker rejected before calling fn at all — no new fetch calls.
      expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBeforeOpen);
    });

    it("returns { ok: false } when the OAuth exchange fails", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      });

      const { sendFcmNotification } = await import("../../../src/modules/notification/fcm.client.js");
      const result = await sendFcmNotification({ token: "tok-1", title: "Hi", body: "there" });
      expect(result).toEqual({ ok: false });
    });

    it("returns { ok: false } when fetch throws", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));
      const { sendFcmNotification } = await import("../../../src/modules/notification/fcm.client.js");
      const result = await sendFcmNotification({ token: "tok-1", title: "Hi", body: "there" });
      expect(result).toEqual({ ok: false });
    });

    it("sets android priority HIGH and includes a ttl when both are provided", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "at-1", expires_in: 3600 }) })
        .mockResolvedValueOnce({ ok: true });

      const { sendFcmNotification } = await import("../../../src/modules/notification/fcm.client.js");
      await sendFcmNotification({ token: "tok-1", title: "Hi", body: "there", priority: "high", ttl: 60 });

      const [, sendOpts] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
      const body = JSON.parse(sendOpts.body);
      expect(body.message.android.priority).toBe("HIGH");
      expect(body.message.android.ttl).toBe("60s");
    });

    it("reuses a cached access token across calls within its validity window", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "at-1", expires_in: 3600 }) })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true });

      const { sendFcmNotification } = await import("../../../src/modules/notification/fcm.client.js");
      await sendFcmNotification({ token: "tok-1", title: "Hi", body: "there" });
      await sendFcmNotification({ token: "tok-2", title: "Hi", body: "there" });

      // Only one OAuth exchange (2 fetch calls total: 1 auth + 2 sends = 3, not 4).
      expect(fetch).toHaveBeenCalledTimes(3);
    });
  });

  it("returns { ok: false } when credentials are only partially configured", async () => {
    process.env.FCM_PROJECT_ID = "my-project";
    // FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY intentionally left unset.
    const { sendFcmNotification } = await import("../../../src/modules/notification/fcm.client.js");
    const result = await sendFcmNotification({ token: "tok-1", title: "Hi", body: "there" });
    expect(result).toEqual({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
