import { ObjectId } from "mongodb";
import { connectMongo } from "../../shared/db/mongo.client.js";
import { sendFcmNotification } from "./fcm.client.js";
import { sendApnsNotification, sendVoipPush } from "./apns.client.js";
import logger from "../../shared/observability/logger.js";

export type Platform = "android" | "ios" | "web";

export interface DeviceDocument {
  _id: ObjectId;
  userId: string;
  platform: Platform;
  token: string;
  voipToken?: string;
  createdAt: Date;
  updatedAt: Date;
}

async function getDevicesCollection() {
  const db = await connectMongo();
  return db.collection<DeviceDocument>("devices");
}

export async function registerDevice(
  userId: string,
  platform: Platform,
  token: string,
  voipToken?: string
): Promise<void> {
  const col = await getDevicesCollection();
  const now = new Date();
  await col.updateOne(
    { userId, platform, token },
    { $set: { userId, platform, token, voipToken, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
}

export async function unregisterDevice(userId: string, token: string): Promise<void> {
  const col = await getDevicesCollection();
  await col.deleteOne({ userId, token });
}

/** Clear a dead VoIP token without deleting the device's primary (alert) token registration. */
export async function clearVoipToken(userId: string, voipToken: string): Promise<void> {
  const col = await getDevicesCollection();
  await col.updateOne({ userId, voipToken }, { $unset: { voipToken: "" } });
}

async function getDevicesForUser(userId: string): Promise<DeviceDocument[]> {
  const col = await getDevicesCollection();
  return col.find({ userId }).toArray();
}

export interface IncomingCallPayload {
  callId: string;
  callerId: string;
  callerName: string;
  callerAvatar?: string | null;
  callType: "audio" | "video";
  roomId: string;
}

export async function notifyIncomingCall(userId: string, payload: IncomingCallPayload): Promise<void> {
  let devices: DeviceDocument[];
  try {
    devices = await getDevicesForUser(userId);
  } catch (err) {
    logger.error({ err, userId }, "Failed to fetch devices for push");
    return;
  }

  if (devices.length === 0) {
    logger.debug({ userId }, "No registered devices - skipping push");
    return;
  }

  const data: Record<string, string> = {
    type: "incoming_call",
    callId: payload.callId,
    callerId: payload.callerId,
    callerName: payload.callerName,
    callerAvatar: payload.callerAvatar ?? "",
    callType: payload.callType,
    roomId: payload.roomId,
  };

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      if (device.platform === "ios") {
        if (device.voipToken) {
          const result = await sendVoipPush(device.voipToken, { ...data, "content-available": 1 });
          return { device, token: device.voipToken, isVoip: true, result };
        }
        const result = await sendApnsNotification({
          deviceToken: device.token,
          pushType: "alert",
          priority: 10,
          aps: {
            alert: { title: "Incoming Call", body: `${payload.callerName} is calling` },
            sound: "default",
            "content-available": 1,
          },
          data,
        });
        return { device, token: device.token, isVoip: false, result };
      }
      const result = await sendFcmNotification({
        token: device.token,
        title: "Incoming Call",
        body: `${payload.callerName} is calling`,
        data,
        priority: "high",
        ttl: 60,
      });
      return { device, token: device.token, isVoip: false, result };
    })
  );

  await pruneDeadDevices(results);
}

/** Stop retrying tokens FCM/APNs reported as permanently invalid (UNREGISTERED / 410 Gone). */
async function pruneDeadDevices(
  results: PromiseSettledResult<{
    device: DeviceDocument;
    token: string;
    isVoip: boolean;
    result: { ok: boolean; permanentFailure?: boolean };
  }>[]
): Promise<void> {
  for (const settled of results) {
    if (settled.status !== "fulfilled") continue;
    const { device, token, isVoip, result } = settled.value;
    if (!result.permanentFailure) continue;

    const prune = isVoip ? clearVoipToken(device.userId, token) : unregisterDevice(device.userId, token);
    await prune.catch((err: unknown) =>
      logger.warn({ err, userId: device.userId, platform: device.platform, isVoip }, "Failed to prune dead device token")
    );
  }
}

export async function notifyMissedCall(
  userId: string,
  payload: { callId: string; callerName: string }
): Promise<void> {
  let devices: DeviceDocument[];
  try {
    devices = await getDevicesForUser(userId);
  } catch (err) {
    logger.error({ err, userId }, "Failed to fetch devices for missed call notification");
    return;
  }

  const data: Record<string, string> = {
    type: "missed_call",
    callId: payload.callId,
    callerName: payload.callerName,
  };

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      if (device.platform === "ios") {
        const result = await sendApnsNotification({
          deviceToken: device.token,
          pushType: "alert",
          aps: {
            alert: { title: "Missed Call", body: `You missed a call from ${payload.callerName}` },
            sound: "default",
          },
          data,
        });
        return { device, token: device.token, isVoip: false, result };
      }
      const result = await sendFcmNotification({
        token: device.token,
        title: "Missed Call",
        body: `You missed a call from ${payload.callerName}`,
        data,
      });
      return { device, token: device.token, isVoip: false, result };
    })
  );

  await pruneDeadDevices(results);
}
