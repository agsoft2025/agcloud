import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

describe("apns.client", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn());
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("APNS_")) delete process.env[key];
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("skips and returns { ok: false } when APNS_BUNDLE_ID is not configured", async () => {
    const { sendApnsNotification } = await import("../../../src/modules/notification/apns.client.js");
    const result = await sendApnsNotification({ deviceToken: "tok-1" });
    expect(result).toEqual({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  describe("when configured", () => {
    beforeEach(() => {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
      process.env.APNS_BUNDLE_ID = "com.example.app";
      process.env.APNS_KEY_ID = "KEYID123";
      process.env.APNS_TEAM_ID = "TEAMID123";
      process.env.APNS_PRIVATE_KEY = pem;
    });

    it("returns { ok: true } when the push succeeds", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
      const { sendApnsNotification } = await import("../../../src/modules/notification/apns.client.js");
      const result = await sendApnsNotification({ deviceToken: "tok-1" });
      expect(result).toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("tok-1");
      expect(opts.headers.authorization).toMatch(/^bearer /);
    });

    it("does not retry and reports permanentFailure on BadDeviceToken", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ reason: "BadDeviceToken" }),
      });
      const { sendApnsNotification } = await import("../../../src/modules/notification/apns.client.js");
      const result = await sendApnsNotification({ deviceToken: "tok-1" });
      expect(result).toEqual({ ok: false, permanentFailure: true });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("does not retry and reports permanentFailure on HTTP 410 Gone", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 410,
        json: async () => ({ reason: "Unregistered" }),
      });
      const { sendApnsNotification } = await import("../../../src/modules/notification/apns.client.js");
      const result = await sendApnsNotification({ deviceToken: "tok-1" });
      expect(result).toEqual({ ok: false, permanentFailure: true });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("retries a transient (5xx) failure and eventually succeeds", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ reason: "InternalServerError" }) })
        .mockResolvedValueOnce({ ok: true });

      const { sendApnsNotification } = await import("../../../src/modules/notification/apns.client.js");
      const result = await sendApnsNotification({ deviceToken: "tok-1" });
      expect(result).toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("returns { ok: false } after exhausting retries on repeated transient failure", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ reason: "ServiceUnavailable" }),
      });
      const { sendApnsNotification } = await import("../../../src/modules/notification/apns.client.js");
      const result = await sendApnsNotification({ deviceToken: "tok-1" });
      expect(result).toEqual({ ok: false });
      expect(fetch).toHaveBeenCalledTimes(5);
    });

    it("returns { ok: false } when fetch throws", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));
      const { sendApnsNotification } = await import("../../../src/modules/notification/apns.client.js");
      const result = await sendApnsNotification({ deviceToken: "tok-1" });
      expect(result).toEqual({ ok: false });
    });

    it("opens the circuit breaker after repeated failures and fast-fails with circuitOpen", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 410,
        json: async () => ({ reason: "Unregistered" }),
      });
      const { sendApnsNotification } = await import("../../../src/modules/notification/apns.client.js");

      // failureThreshold: 5 — each of these is a single-attempt permanent
      // failure (no retry), so this stays fast.
      for (let i = 0; i < 5; i++) {
        const result = await sendApnsNotification({ deviceToken: `tok-${i}` });
        expect(result).toEqual({ ok: false, permanentFailure: true });
      }

      const callsBeforeOpen = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

      const result = await sendApnsNotification({ deviceToken: "tok-blocked" });
      expect(result).toEqual({ ok: false, circuitOpen: true });
      expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBeforeOpen);
    });

    it("returns { ok: false } when credentials are only partially configured", async () => {
      delete process.env.APNS_TEAM_ID;
      const { sendApnsNotification } = await import("../../../src/modules/notification/apns.client.js");
      const result = await sendApnsNotification({ deviceToken: "tok-1" });
      expect(result).toEqual({ ok: false });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("reuses a cached token across calls within its validity window", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
      const { sendApnsNotification } = await import("../../../src/modules/notification/apns.client.js");
      await sendApnsNotification({ deviceToken: "tok-1" });
      await sendApnsNotification({ deviceToken: "tok-2" });

      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][1].headers.authorization).toBe(calls[1][1].headers.authorization);
    });

    it("uses the production APNs host when APNS_PRODUCTION=true", async () => {
      process.env.APNS_PRODUCTION = "true";
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
      const { sendApnsNotification } = await import("../../../src/modules/notification/apns.client.js");
      await sendApnsNotification({ deviceToken: "tok-1" });
      const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("api.push.apple.com");
    });

    it("sendVoipPush sends with voip pushType and priority/expiration set", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
      const { sendVoipPush } = await import("../../../src/modules/notification/apns.client.js");
      const result = await sendVoipPush("voip-tok", { callId: "abc" });
      expect(result).toEqual({ ok: true });
      const [, opts] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts.headers["apns-push-type"]).toBe("voip");
      expect(opts.headers["apns-topic"]).toBe("com.example.app.voip");
    });
  });
});
