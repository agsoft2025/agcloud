import { AccessToken, VideoGrant, RoomServiceClient, EgressClient } from "livekit-server-sdk";
import type { RoomCompositeOptions } from "livekit-server-sdk/dist/EgressClient";
import config from "../../config/index.js";

const roomService = new RoomServiceClient(
  config.livekitUrl,
  config.livekitApiKey,
  config.livekitApiSecret
);

const egressClient = new EgressClient(
  config.livekitUrl,
  config.livekitApiKey,
  config.livekitApiSecret
);
// Start a room composite recording (egress)
export async function startRoomRecording(roomName: string, fileOutput: { filepath: string }, options?: Partial<RoomCompositeOptions>) {
  // fileOutput: { filepath: "/recordings/room-<roomName>-<timestamp>.mp4" }
  // options: { layout, audioOnly, videoOnly, encodingOptions, ... }
  return await egressClient.startRoomCompositeEgress(
    roomName,
    fileOutput as any,
    options || {}
  );
}

// Stop a recording by egressId
export async function stopRecording(egressId: string) {
  return await egressClient.stopEgress(egressId);
}

export async function endLiveKitRoom(roomName: string): Promise<void> {
  try {
    await roomService.deleteRoom(roomName);
  } catch (error) {
    console.warn(`LiveKit room "${roomName}" could not be deleted.`, error);
  }
}

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
