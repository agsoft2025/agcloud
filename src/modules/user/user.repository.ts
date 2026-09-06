import { ObjectId } from "mongodb";
import { connectMongo } from "../../shared/db/mongo.client.js";
import { UserDocument } from "./user.schemas.js";

export interface ListContactsOptions {
  page: number;
  limit: number;
  search?: string;
  excludeUserId?: string;
}

export interface ListContactsResult {
  users: UserDocument[];
  total: number;
  page: number;
  limit: number;
}

export class UserRepository {
  private async getCollection() {
    const db = await connectMongo();
    return db.collection<UserDocument>("users");
  }

  /** Return every user document — no filters. Used by admin endpoints. */
  async findAll(): Promise<UserDocument[]> {
    const collection = await this.getCollection();
    return collection.find({}).sort({ createdAt: -1 }).toArray();
  }

  async listContacts(options: ListContactsOptions): Promise<ListContactsResult> {
    const collection = await this.getCollection();
    const { page, limit, search, excludeUserId } = options;

    const filter: Record<string, unknown> = {
      status: { $nin: ["suspended", "deleted"] },
      isBlocked: { $ne: true },
    };

    if (excludeUserId) {
      try {
        filter._id = { $ne: new ObjectId(excludeUserId) };
      } catch {
        // ignore invalid id
      }
    }

    if (search?.trim()) {
      const regex = new RegExp(search.trim(), "i");
      filter.$or = [
        { displayName: regex },
        { email: regex },
        { phoneNumber: regex },
        { extensionNumber: regex },
      ];
    }

    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      collection.find(filter).skip(skip).limit(limit).toArray(),
      collection.countDocuments(filter),
    ]);

    return { users, total, page, limit };
  }

  async getAllPresence(): Promise<Array<{ userId: string; status: string; lastSeen?: Date }>> {
    const collection = await this.getCollection();
    const users = await collection
      .find({}, { projection: { presenceStatus: 1, lastSeenAt: 1 } })
      .toArray();

    return users.map((user) => ({
      userId: user._id.toString(),
      status: user.presenceStatus ?? "offline",
      lastSeen: user.lastSeenAt,
    }));
  }

  async setPresence(userId: string, status: UserDocument["presenceStatus"]): Promise<void> {
    const collection = await this.getCollection();
    try {
      await collection.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { presenceStatus: status, lastSeenAt: new Date() } }
      );
    } catch {
      // ignore invalid id
    }
  }

  async getUserById(id: string): Promise<UserDocument | null> {
    const collection = await this.getCollection();
    try {
      return await collection.findOne({ _id: new ObjectId(id) });
    } catch {
      return null;
    }
  }

  /**
   * Persists presence state to the database.
   * Called by the presence worker (every 5 min) and immediately on OFFLINE transition.
   * Maps uppercase Redis status (ONLINE|AWAY|OFFLINE) to lowercase DB enum values.
   * Only writes status, lastSeen, and updatedAt -- never heartbeat or activity timestamps.
   */
  async syncPresenceToDb(
    userId: string,
    status: "ONLINE" | "AWAY" | "OFFLINE",
    lastSeen?: Date
  ): Promise<void> {
    const collection = await this.getCollection();
    try {
      const dbStatus = status.toLowerCase() as UserDocument["presenceStatus"];
      const update: Record<string, unknown> = {
        presenceStatus: dbStatus,
        updatedAt: new Date(),
      };
      if (lastSeen) {
        update.lastSeenAt = lastSeen;
      }
      await collection.updateOne(
        { _id: new ObjectId(userId) },
        { $set: update }
      );
    } catch {
      // Ignore invalid ObjectId or DB errors -- Redis remains authoritative
    }
  }
}
