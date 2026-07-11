import { randomUUID } from "crypto";
import { connectMongo } from "../../shared/db/mongo.client.js";
import config from "../../config/index.js";
import type { DeviceInfo, RefreshTokenDocument, RevokedReason, SessionSummary } from "./auth.types.js";

const COLLECTION = "refresh_tokens";

function ttlDate(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export class RefreshTokenRepository {
  private async getCollection() {
    const db = await connectMongo();
    return db.collection<RefreshTokenDocument>(COLLECTION);
  }

  /** Start a brand-new login session (new family). Used by signin. */
  async createFamily(userId: string, deviceInfo: DeviceInfo): Promise<{ jti: string; familyId: string }> {
    const collection = await this.getCollection();
    const jti = randomUUID();
    const familyId = randomUUID();
    const now = new Date();

    const doc: Omit<RefreshTokenDocument, "_id"> = {
      jti,
      userId,
      familyId,
      familyCreatedAt: now,
      issuedAt: now,
      expiresAt: ttlDate(config.refreshTokenTtlDays),
      used: false,
      usedAt: null,
      revoked: false,
      revokedAt: null,
      revokedReason: null,
      replacedByJti: null,
      deviceInfo,
    };

    await collection.insertOne(doc as RefreshTokenDocument);
    return { jti, familyId };
  }

  async findByJti(jti: string): Promise<RefreshTokenDocument | null> {
    const collection = await this.getCollection();
    return collection.findOne({ jti });
  }

  /**
   * Rotate: mark the presented token as used and issue the next token in the
   * same family. Caller is responsible for having already validated that the
   * presented token is not revoked/used/expired via `findByJti`.
   */
  async rotate(previous: RefreshTokenDocument): Promise<{ jti: string }> {
    const collection = await this.getCollection();
    const newJti = randomUUID();
    const now = new Date();

    // Cap this rotation's expiry at the family's absolute max age so the TTL
    // index never keeps a session-family alive past its hard limit, even if
    // every individual rotation's sliding window would otherwise allow it.
    const absoluteExpiry = new Date(
      previous.familyCreatedAt.getTime() + config.refreshTokenFamilyMaxAgeDays * 24 * 60 * 60 * 1000
    );
    const slidingExpiry = ttlDate(config.refreshTokenTtlDays);
    const expiresAt = slidingExpiry < absoluteExpiry ? slidingExpiry : absoluteExpiry;

    await collection.insertOne({
      jti: newJti,
      userId: previous.userId,
      familyId: previous.familyId,
      familyCreatedAt: previous.familyCreatedAt,
      issuedAt: now,
      expiresAt,
      used: false,
      usedAt: null,
      revoked: false,
      revokedAt: null,
      revokedReason: null,
      replacedByJti: null,
      deviceInfo: previous.deviceInfo,
    } as RefreshTokenDocument);

    await collection.updateOne(
      { jti: previous.jti },
      { $set: { used: true, usedAt: now, replacedByJti: newJti } }
    );

    return { jti: newJti };
  }

  /** Revoke every non-revoked token in a family (logout, theft detection, family max-age). */
  async revokeFamily(familyId: string, reason: RevokedReason): Promise<void> {
    const collection = await this.getCollection();
    await collection.updateMany(
      { familyId, revoked: false },
      { $set: { revoked: true, revokedAt: new Date(), revokedReason: reason } }
    );
  }

  /** Revoke every non-revoked token for a user across every device ("logout everywhere"). */
  async revokeAllForUser(userId: string, reason: RevokedReason): Promise<void> {
    const collection = await this.getCollection();
    await collection.updateMany(
      { userId, revoked: false },
      { $set: { revoked: true, revokedAt: new Date(), revokedReason: reason } }
    );
  }

  /**
   * Revoke a single family, but only if it belongs to `userId` — prevents one
   * user from revoking another user's session by guessing a familyId.
   */
  async revokeFamilyForUser(familyId: string, userId: string, reason: RevokedReason): Promise<boolean> {
    const collection = await this.getCollection();
    const result = await collection.updateMany(
      { familyId, userId, revoked: false },
      { $set: { revoked: true, revokedAt: new Date(), revokedReason: reason } }
    );
    return result.matchedCount > 0;
  }

  /** One row per active (non-revoked, non-expired) login family, most-recent rotation first. */
  async listActiveSessionsForUser(userId: string, currentFamilyId?: string): Promise<SessionSummary[]> {
    const collection = await this.getCollection();
    const docs = await collection
      .find({ userId, revoked: false, expiresAt: { $gt: new Date() } })
      .sort({ issuedAt: -1 })
      .toArray();

    const byFamily = new Map<string, RefreshTokenDocument>();
    for (const doc of docs) {
      // First hit per familyId (due to sort desc) is the latest rotation.
      if (!byFamily.has(doc.familyId)) byFamily.set(doc.familyId, doc);
    }

    return Array.from(byFamily.values()).map((doc) => ({
      familyId: doc.familyId,
      createdAt: doc.familyCreatedAt.toISOString(),
      lastUsedAt: doc.issuedAt.toISOString(),
      expiresAt: doc.expiresAt.toISOString(),
      deviceInfo: doc.deviceInfo,
      isCurrent: doc.familyId === currentFamilyId,
    }));
  }
}
