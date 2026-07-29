import logger from "../../shared/observability/logger.js";
import { pushNotificationsFailed, pushNotificationsSent } from "../../shared/observability/metrics.js";
import { withRetry } from "../../shared/utils/retry.js";
import { CircuitBreaker, CircuitOpenError } from "../../shared/utils/circuit-breaker.js";
import { setCircuitBreakerState } from "../../shared/observability/metrics.js";

export interface ApnsSendResult {
  ok: boolean;
  /** True on HTTP 410 (Gone) — the token is permanently invalid; caller should unregister the device. */
  permanentFailure?: boolean;
  /** True when the APNs circuit breaker is OPEN — caller should fall back to the retry queue instead of dropping the notification. */
  circuitOpen?: boolean;
}

/** Thrown for APNs errors that will never succeed on retry — a dead/unregistered device token. */
class ApnsPermanentError extends Error {}

// Spec §6.4: 50% failure rate over 60s / 10s timeout / 120s reset — same
// consecutive-failure approximation used for LiveKit and FCM (see fcm.client.ts).
const apnsBreaker = new CircuitBreaker({
  name: "apns",
  failureThreshold: 5,
  openDurationMs: 120_000,
  timeout: 10_000,
  onStateChange: (state) => setCircuitBreakerState("apns", state),
});

export interface ApnsPayload {
  deviceToken: string;
  pushType?: "alert" | "voip" | "background";
  topic?: string;
  priority?: 10 | 5;
  expiration?: number;
  aps?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

let _apnsToken: string | null = null;
let _apnsTokenIssuedAt = 0;

async function getApnsToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (_apnsToken && now - _apnsTokenIssuedAt < 55 * 60) return _apnsToken;

  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const privateKeyRaw = process.env.APNS_PRIVATE_KEY;

  if (!keyId || !teamId || !privateKeyRaw) {
    throw new Error("APNs credentials not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY)");
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const { default: jwt } = await import("jsonwebtoken");
  _apnsToken = jwt.sign({ iss: teamId, iat: now }, privateKey, {
    algorithm: "ES256",
    header: { alg: "ES256", kid: keyId },
  });
  _apnsTokenIssuedAt = now;
  return _apnsToken;
}

async function sendOnce(host: string, topic: string, pushType: string, payload: ApnsPayload): Promise<void> {
  const token = await getApnsToken();
  const body = { aps: payload.aps ?? {}, ...(payload.data ?? {}) };

  const res = await fetch(`${host}/3/device/${payload.deviceToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "apns-push-type": pushType,
      "apns-topic": topic,
      "apns-priority": String(payload.priority ?? 10),
      ...(payload.expiration !== undefined && { "apns-expiration": String(payload.expiration) }),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const apnsError = await res.json().catch(() => ({}) as any);
    logger.error({ apnsError, status: res.status }, "APNs send failed");

    // 410 Gone = token permanently invalid (device uninstalled the app / token expired).
    // 400 BadDeviceToken is effectively the same signal for a malformed/stale token.
    if (res.status === 410 || apnsError?.reason === "BadDeviceToken") {
      throw new ApnsPermanentError(apnsError?.reason ?? "Gone");
    }
    throw new Error(`APNs send failed with status ${res.status}`);
  }
}

export async function sendApnsNotification(payload: ApnsPayload): Promise<ApnsSendResult> {
  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!bundleId) {
    logger.warn("APNS_BUNDLE_ID not set - skipping APNs push");
    return { ok: false };
  }

  const isProduction = process.env.APNS_PRODUCTION === "true";
  const host = isProduction ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  const pushType = payload.pushType ?? "alert";
  const topic = payload.topic ?? (pushType === "voip" ? `${bundleId}.voip` : bundleId);

  try {
    await apnsBreaker.execute(() =>
      withRetry(() => sendOnce(host, topic, pushType, payload), {
        maxAttempts: 5,
        maxDelayMs: 60_000,
        retryOn: (err) => !(err instanceof ApnsPermanentError),
      })
    );
    pushNotificationsSent.inc({ platform: "apns" });
    return { ok: true };
  } catch (err) {
    pushNotificationsFailed.inc({ platform: "apns" });
    if (err instanceof ApnsPermanentError) {
      return { ok: false, permanentFailure: true };
    }
    if (err instanceof CircuitOpenError) {
      return { ok: false, circuitOpen: true };
    }
    logger.error({ err }, "APNs send exception");
    return { ok: false };
  }
}

export async function sendVoipPush(deviceToken: string, data: Record<string, unknown>): Promise<ApnsSendResult> {
  return sendApnsNotification({ deviceToken, pushType: "voip", priority: 10, expiration: 0, aps: {}, data });
}
