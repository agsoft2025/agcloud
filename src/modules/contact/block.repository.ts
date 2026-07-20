import { connectMongo } from "../../shared/db/mongo.client.js";

export interface BlockDocument {
  blockerId: string;
  blockedId: string;
  createdAt: Date;
}

export class BlockRepository {
  private async getCollection() {
    const db = await connectMongo();
    return db.collection<BlockDocument>("blocks");
  }

  async block(blockerId: string, blockedId: string): Promise<void> {
    const collection = await this.getCollection();
    await collection.updateOne(
      { blockerId, blockedId },
      { $setOnInsert: { blockerId, blockedId, createdAt: new Date() } },
      { upsert: true }
    );
  }

  async unblock(blockerId: string, blockedId: string): Promise<boolean> {
    const collection = await this.getCollection();
    const result = await collection.deleteOne({ blockerId, blockedId });
    return result.deletedCount > 0;
  }

  async listBlockedIds(blockerId: string): Promise<string[]> {
    const collection = await this.getCollection();
    const docs = await collection.find({ blockerId }).toArray();
    return docs.map((d) => d.blockedId);
  }

  /** True if either user has blocked the other. Used to guard call initiation. */
  async isBlockedEitherWay(userA: string, userB: string): Promise<boolean> {
    const collection = await this.getCollection();
    const doc = await collection.findOne({
      $or: [
        { blockerId: userA, blockedId: userB },
        { blockerId: userB, blockedId: userA },
      ],
    });
    return doc !== null;
  }

  /** From a list of candidate users, return those blocked-either-way with `userId`. */
  async filterBlockedEitherWay(userId: string, candidateIds: string[]): Promise<string[]> {
    if (candidateIds.length === 0) return [];
    const collection = await this.getCollection();
    const docs = await collection
      .find({
        $or: [
          { blockerId: userId, blockedId: { $in: candidateIds } },
          { blockedId: userId, blockerId: { $in: candidateIds } },
        ],
      })
      .toArray();

    const blocked = new Set<string>();
    for (const doc of docs) {
      blocked.add(doc.blockerId === userId ? doc.blockedId : doc.blockerId);
    }
    return [...blocked];
  }
}
