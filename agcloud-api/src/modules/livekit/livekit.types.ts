import type { WebhookEvent } from "livekit-server-sdk";

export interface TokenRequest {
  roomName: string;
  identity: string;
  name?: string;
  ttl?: number; // seconds, default 3600
}

export interface TokenResponse {
  token: string;
  livekitUrl: string;
}

export interface CreateRoomOptions {
  name: string;
  emptyTimeout?: number;    // seconds before empty room is deleted, default 300
  maxParticipants?: number; // 0 = unlimited
}

export interface RoomInfo {
  sid: string;
  name: string;
  numParticipants: number;
  creationTime: number;
}

export type LiveKitWebhookEvent = WebhookEvent;
