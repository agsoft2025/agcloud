import logger from "../../shared/observability/logger.js";
import { pushNotificationsFailed, pushNotificationsSent } from "../../shared/observability/metrics.js";
import { withRetry } from "../../shared/utils/retry.js";
import { CircuitBreaker, CircuitOpenError } from "../../shared/utils/circuit-breaker.js";
import { setCircuitBreakerState } from "../../shared/observability/metrics.js";

export interface FcmMessage {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  priority?: "high" | "normal";
  ttl?: number;
}

export interface FcmSendResult {
  ok: boolean;
  /** True when FCM reports the token itself is dead (UNREGISTERED/NOT_FOUND) — caller should stop retrying and unregister the device. */
  permanentFailure?: boolean;
  /** True when the FCM circuit breaker is OPEN — caller should fall back to the retry queue instead of dropping the notification. */
  circuitOpen?: boolean;
}

/** Thrown for FCM errors that will never succeed on retry — a dead/invalid registration token. */
class FcmPermanentError extends Error {}

const PERMANENT_FCM_ERROR_CODES = new Set(["UNREGISTERED", "NOT_FOUND", "INVALID_ARGUMENT"]);

// Spec §6.4: 50% failure rate over 60s / 10s timeout / 120s reset. This
// breaker's simple consecutive-failure count is the same approximation
// already used for LiveKit (livekit.service.ts) rather than a windowed
// percentage, since that's what the shared CircuitBreaker utility supports.
const fcmBreaker = new CircuitBreaker({
  name: "fcm",
  failureThreshold: 5,
  openDurationMs: 120_000,
  timeout: 10_000,
  onStateChange: (state) => setCircuitBreakerState("fcm", state),
});

let _accessToken: string | null = null;
let _tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (_accessToken && Date.now() < _tokenExpiresAt - 60_000) return _accessToken;

  const projectId = process.env.FCM_PROJECT_ID;
  const clientEmail = process.env.FCM_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FCM_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKeyRaw) {
    throw new Error("FCM credentials not configured (FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY)");
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const { default: jwt } = await import("jsonwebtoken");
  const assertion = jwt.sign(payload, privateKey, { algorithm: "RS256" });

  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: params,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (!res.ok) throw new Error(`FCM OAuth failed: ${res.status} ${await res.text()}`);

  const json = (await res.json()) as { access_token: string; expires_in: number };
  _accessToken = json.access_token;
  _tokenExpiresAt = Date.now() + json.expires_in * 1000;
  return _accessToken;
}

async function sendOnce(projectId: string, message: FcmMessage): Promise<void> {
  const token = await getAccessToken();
  const body = {
    message: {
      token: message.token,
      notification: { title: message.title, body: message.body },
      data: message.data ?? {},
      android: {
        priority: message.priority === "high" ? "HIGH" : "NORMAL",
        ...(message.ttl !== undefined && { ttl: `${message.ttl}s` }),
      },
    },
  };

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const fcmError = await res.json().catch(() => ({}) as any);
    const errorCode = fcmError?.error?.status as string | undefined;
    logger.error({ fcmError, status: res.status }, "FCM send failed");

    if (errorCode && PERMANENT_FCM_ERROR_CODES.has(errorCode)) {
      throw new FcmPermanentError(errorCode);
    }
    throw new Error(`FCM send failed with status ${res.status}`);
  }
}

export async function sendFcmNotification(message: FcmMessage): Promise<FcmSendResult> {
  const projectId = process.env.FCM_PROJECT_ID;
  if (!projectId) {
    logger.warn("FCM_PROJECT_ID not set - skipping push");
    return { ok: false };
  }

  try {
    await fcmBreaker.execute(() =>
      withRetry(() => sendOnce(projectId, message), {
        maxAttempts: 5,
        maxDelayMs: 60_000,
        retryOn: (err) => !(err instanceof FcmPermanentError),
      })
    );
    pushNotificationsSent.inc({ platform: "fcm" });
    return { ok: true };
  } catch (err) {
    pushNotificationsFailed.inc({ platform: "fcm" });
    if (err instanceof FcmPermanentError) {
      return { ok: false, permanentFailure: true };
    }
    if (err instanceof CircuitOpenError) {
      return { ok: false, circuitOpen: true };
    }
    logger.error({ err }, "FCM send exception");
    return { ok: false };
  }
}
