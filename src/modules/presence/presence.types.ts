/**
 * Presence status values — uppercase, backend-canonical.
 * The persistent DB stores lowercase equivalents ("online" | "away" | "offline").
 */
export type PresenceStatus = "ONLINE" | "AWAY" | "OFFLINE";

/**
 * Shape of the Redis hash stored at  presence:user:{userId}
 * All timestamps are ISO-8601 strings.
 */
export interface RedisPresenceData {
  status: PresenceStatus;
  /** Updated only on real user interactions (never from heartbeat). */
  lastActivity: string;
  /** Updated only by WebSocket PING heartbeats. */
  lastHeartbeat: string;
  /** Set only when the user transitions to OFFLINE. Used for "Last Seen". */
  lastSeen: string;
}

/**
 * Payload published to the Redis presence:broadcast channel and emitted
 * to Socket.IO clients.
 */
export interface PresenceBroadcast {
  event: "USER_ONLINE" | "USER_AWAY" | "USER_OFFLINE" | "PRESENCE_UPDATED";
  userId: string;
  status: PresenceStatus;
  lastSeen?: string;
  activeDevices?: number;
}
