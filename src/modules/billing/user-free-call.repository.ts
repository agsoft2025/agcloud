/**
 * user-free-call.repository.ts
 *
 * Tracks whether a user has consumed their one lifetime free call.
 *
 * One document per userId (upsert-based singleton).
 * Once `used` is true it never goes back to false — the only way to get
 * unlimited calls is to subscribe.
 */
import { connectMongo } from "../../shared/db/mongo.client.js";
import { ObjectId } from "mongodb";

interface UserFreeCallUsageDocument {
  _id: ObjectId;
  userId: string;
  used: boolean;
  callId: string | null;   // the call that triggered the cutoff
  usedAt: Date | null;
  createdAt: Date;
}

export class UserFreeCallRepository {
  private async col() {
    const db = await connectMongo();
    return db.collection<UserFreeCallUsageDocument>("user_free_call_usage");
  }

  /** Returns true if this user has already consumed their free call. */
  async hasUsedFreeCall(userId: string): Promise<boolean> {
    const col = await this.col();
    const doc = await col.findOne({ userId });
    return doc?.used ?? false;
  }

  /**
   * Mark the user's free call as consumed.
   * Idempotent: calling it multiple times for the same user is safe.
   */
  async markFreeCallUsed(userId: string, callId: string): Promise<void> {
    const col = await this.col();
    const now = new Date();
    await col.updateOne(
      { userId },
      {
        $set:         { used: true, callId, usedAt: now },
        $setOnInsert: { userId, createdAt: now },
      },
      { upsert: true },
    );
  }
}
