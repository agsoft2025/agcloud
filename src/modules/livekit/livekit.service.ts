import { AccessToken, VideoGrant, RoomServiceClient } from "livekit-server-sdk";
import config from "../../config/index.js";

const roomService = new RoomServiceClient(
  config.livekitUrl,
  config.livekitApiKey,
  config.livekitApiSecret
);

export async function createLiveKitToken(identity: string, roomName: string) {
  const at = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity,
    ttl: 60 * 60
  });

  const grant: VideoGrant = {
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  };
  at.addGrant(grant);

  return await at.toJwt();
}

export async function checkLiveKitHealth(): Promise<boolean> {
  try {
    // List rooms as a lightweight way to verify connectivity and credentials
    await roomService.listRooms();
    return true;
  } catch (error) {
    console.error("LiveKit Health Check Failed:", error);
    return false;
  }
}

export function getLiveKitBaseUrl() {
  return config.livekitUrl;
}
