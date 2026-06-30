import logger from "../../shared/observability/logger.js";
import { pushNotificationsFailed, pushNotificationsSent } from "../../shared/observability/metrics.js";

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

export async function sendApnsNotification(payload: ApnsPayload): Promise<boolean> {
  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!bundleId) {
    logger.warn("APNS_BUNDLE_ID not set - skipping APNs push");
    return false;
  }

  const isProduction = process.env.APNS_PRODUCTION === "true";
  const host = isProduction ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  const pushType = payload.pushType ?? "alert";
  const topic = payload.topic ?? (pushType === "voip" ? `${bundleId}.voip` : bundleId);

  try {
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
      logger.error({ apnsError: await res.json().catch(() => ({})), status: res.status }, "APNs send failed");
      pushNotificationsFailed.inc({ platform: "apns" });
      return false;
    }

    pushNotificationsSent.inc({ platform: "apns" });
    return true;
  } catch (err) {
    logger.error({ err }, "APNs send exception");
    pushNotificationsFailed.inc({ platform: "apns" });
    return false;
  }
}

export async function sendVoipPush(deviceToken: string, data: Record<string, unknown>): Promise<boolean> {
  return sendApnsNotification({ deviceToken, pushType: "voip", priority: 10, expiration: 0, aps: {}, data });
}
