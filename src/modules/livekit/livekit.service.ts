import { AccessToken, VideoGrant, RoomServiceClient, EgressClient } from "livekit-server-sdk";
import type { RoomCompositeOptions } from "livekit-server-sdk/dist/EgressClient";
import config from "../../config/index.js";
import { CircuitBreaker } from "../../shared/utils/circuit-breaker.js";

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

// A LiveKit outage should degrade gracefully — trip open after repeated
// failures instead of letting every call-related request hang/fail slowly
// waiting on a dead server.
const livekitBreaker = new CircuitBreaker({
  name: "livekit",
  failureThreshold: 5,
  openDurationMs: 30_000,
  timeout: 8_000,
});

export async function startRoomRecording(roomName: string, fileOutput: { filepath: string }, options?: Partial<RoomCompositeOptions>) {
  return livekitBreaker.execute(() =>
    egressClient.startRoomCompositeEgress(roomName, fileOutput as any, options || {})
  );
}

export async function stopRecording(egressId: string) {
  return livekitBreaker.execute(() => egressClient.stopEgress(egressId));
}

export async function endLiveKitRoom(roomName: string): Promise<void> {
  try {
    await livekitBreaker.execute(() => roomService.deleteRoom(roomName));
  } catch (error) {
    console.warn(`LiveKit room "${roomName}" could not be deleted.`, error);
  }
}

export async function createLiveKitToken(identity: string, roomName: string) {
  const at = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity,
    ttl: 60 * 60,
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
    await livekitBreaker.execute(() => roomService.listRooms());
    return true;
  } catch (error) {
    console.error("LiveKit Health Check Failed:", error);
    return false;
  }
}

/**
 * Returns the LiveKit URL that clients (browsers / mobile apps) should connect to.
 * In Docker/Kubernetes, LIVEKIT_URL is the internal hostname.
 * Set LIVEKIT_PUBLIC_URL to the public WebSocket URL for clients.
 */
export function getLiveKitPublicUrl(): string {
  return config.livekitPublicUrl ?? config.livekitUrl;
}

/** @deprecated Use getLiveKitPublicUrl() */
export function getLiveKitBaseUrl(): string {
  return getLiveKitPublicUrl();
}
