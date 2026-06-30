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

  await Promise.allSettled(
    devices.map((device) => {
      if (device.platform === "ios") {
        if (device.voipToken) {
          return sendVoipPush(device.voipToken, { ...data, "content-available": 1 });
        }
        return sendApnsNotification({
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
      }
      return sendFcmNotification({
        token: device.token,
        title: "Incoming Call",
        body: `${payload.callerName} is calling`,
        data,
        priority: "high",
        ttl: 60,
      });
    })
  );
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

  await Promise.allSettled(
    devices.map((device) => {
      if (device.platform === "ios") {
        return sendApnsNotification({
          deviceToken: device.token,
          pushType: "alert",
          aps: {
            alert: { title: "Missed Call", body: `You missed a call from ${payload.callerName}` },
            sound: "default",
          },
          data,
        });
      }
      return sendFcmNotification({
        token: device.token,
        title: "Missed Call",
        body: `You missed a call from ${payload.callerName}`,
        data,
      });
    })
  );
}
