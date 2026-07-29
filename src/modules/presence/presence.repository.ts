import { getRedisClient } from "../../shared/db/redis.client.js";
import logger from "../../shared/observability/logger.js";
import type { RedisPresenceData } from "./presence.types.js";

const PRESENCE_KEY = (userId: string) => `presence:user:${userId}`;
const SOCKETS_KEY = (userId: string) => `presence:user:${userId}:sockets`;
const GRACE_KEY = (userId: string) => `presence:user:${userId}:grace`;

export const BROADCAST_CHANNEL = "presence:broadcast";

export class PresenceRepository {
  private get redis() {
    return getRedisClient();
  }

  // Presence hash

  async getPresence(userId: string): Promise<RedisPresenceData | null> {
    const data = await this.redis.hgetall(PRESENCE_KEY(userId));
    if (!data || !data.status) return null;
    return data as unknown as RedisPresenceData;
  }

  async setPresenceFields(userId: string, fields: Partial<RedisPresenceData>): Promise<void> {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    await this.redis.hset(PRESENCE_KEY(userId), Object.fromEntries(entries));
  }

  // Socket set

  async addSocket(userId: string, socketId: string): Promise<void> {
    await this.redis.sadd(SOCKETS_KEY(userId), socketId);
  }

  async removeSocket(userId: string, socketId: string): Promise<void> {
    await this.redis.srem(SOCKETS_KEY(userId), socketId);
  }

  async getSocketCount(userId: string): Promise<number> {
    return this.redis.scard(SOCKETS_KEY(userId));
  }

  // Grace period

  async setGracePeriod(userId: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(GRACE_KEY(userId), "1", "EX", ttlSeconds);
  }

  async clearGracePeriod(userId: string): Promise<void> {
    await this.redis.del(GRACE_KEY(userId));
  }

  async hasGracePeriod(userId: string): Promise<boolean> {
    return (await this.redis.exists(GRACE_KEY(userId))) === 1;
  }

  // Discovery

  async getAllPresenceUserIds(): Promise<string[]> {
    const userIds: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        "presence:user:*",
        "COUNT",
        "100"
      );
      cursor = nextCursor;
      for (const key of keys) {
        if (key.endsWith(":sockets") || key.endsWith(":grace")) continue;
        userIds.push(key.replace("presence:user:", ""));
      }
    } while (cursor !== "0");
    return userIds;
  }

  // Startup cleanup

  /**
   * Deletes ALL presence:user:*:sockets sets in a single pipelined pass.
   * Called once on server startup to purge dead socket IDs left over from
   * a previous process so stale users are not stuck as ONLINE.
   */
  async clearAllSocketSets(): Promise<void> {
    let cursor = "0";
    const keys: string[] = [];
    do {
      const [nextCursor, batch] = await this.redis.scan(
        cursor,
        "MATCH",
        "presence:user:*:sockets",
        "COUNT",
        "100"
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== "0");

    if (keys.length === 0) {
      logger.info("No stale presence socket sets found on startup");
      return;
    }
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.del(key);
    await pipeline.exec();
    logger.info({ count: keys.length }, "Cleared stale presence socket set(s) on startup");
  }

  // Batch helpers (used by contact list enrichment)

  /**
   * Returns socket counts for a list of userIds in a single pipeline round-trip.
   */
  async batchGetSocketCounts(userIds: string[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const pipeline = this.redis.pipeline();
    for (const userId of userIds) pipeline.scard(SOCKETS_KEY(userId));
    const results = await pipeline.exec();
    const counts = new Map<string, number>();
    if (!results) return counts;
    for (let i = 0; i < userIds.length; i++) {
      const [err, val] = results[i] as [Error | null, number];
      counts.set(userIds[i], err ? 0 : (val ?? 0));
    }
    return counts;
  }

  /**
   * Returns presence hashes for a list of userIds in a single pipeline round-trip.
   */
  async batchGetPresence(userIds: string[]): Promise<Map<string, RedisPresenceData | null>> {
    if (userIds.length === 0) return new Map();
    const pipeline = this.redis.pipeline();
    for (const userId of userIds) pipeline.hgetall(PRESENCE_KEY(userId));
    const results = await pipeline.exec();
    const map = new Map<string, RedisPresenceData | null>();
    if (!results) return map;
    for (let i = 0; i < userIds.length; i++) {
      const [err, data] = results[i] as [Error | null, Record<string, string> | null];
      map.set(
        userIds[i],
        !err && data && data.status ? (data as unknown as RedisPresenceData) : null
      );
    }
    return map;
  }

  // Pub/Sub

  async publish(channel: string, message: string): Promise<void> {
    await this.redis.publish(channel, message);
  }
}
