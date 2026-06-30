import logger from "../../shared/observability/logger.js";
import { pushNotificationsFailed, pushNotificationsSent } from "../../shared/observability/metrics.js";

export interface FcmMessage {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  priority?: "high" | "normal";
  ttl?: number;
}

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

export async function sendFcmNotification(message: FcmMessage): Promise<boolean> {
  const projectId = process.env.FCM_PROJECT_ID;
  if (!projectId) {
    logger.warn("FCM_PROJECT_ID not set - skipping push");
    return false;
  }

  try {
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
      logger.error({ fcmError: await res.json().catch(() => ({})) }, "FCM send failed");
      pushNotificationsFailed.inc({ platform: "fcm" });
      return false;
    }

    pushNotificationsSent.inc({ platform: "fcm" });
    return true;
  } catch (err) {
    logger.error({ err }, "FCM send exception");
    pushNotificationsFailed.inc({ platform: "fcm" });
    return false;
  }
}
