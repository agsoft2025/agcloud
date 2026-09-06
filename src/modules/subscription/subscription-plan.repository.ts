import { ObjectId } from "mongodb";
import { connectMongo } from "../../shared/db/mongo.client.js";
import type { SubscriptionPlanDocument } from "./subscription.schemas.js";

export class SubscriptionPlanRepository {
  private async col() {
    const db = await connectMongo();
    return db.collection<SubscriptionPlanDocument>("subscription_plans");
  }

  async create(plan: Omit<SubscriptionPlanDocument, "_id">): Promise<SubscriptionPlanDocument> {
    const col = await this.col();
    const result = await col.insertOne(plan as SubscriptionPlanDocument);
    return { ...plan, _id: result.insertedId };
  }

  async findAll(): Promise<SubscriptionPlanDocument[]> {
    const col = await this.col();
    return col.find({}).sort({ durationMonths: 1 }).toArray();
  }

  async findActive(): Promise<SubscriptionPlanDocument[]> {
    const col = await this.col();
    return col.find({ isActive: true }).sort({ durationMonths: 1 }).toArray();
  }

  async findById(id: string): Promise<SubscriptionPlanDocument | null> {
    try {
      const col = await this.col();
      return await col.findOne({ _id: new ObjectId(id) });
    } catch {
      return null;
    }
  }

  async update(
    id: string,
    updates: Partial<Pick<SubscriptionPlanDocument, "name" | "price" | "isActive" | "updatedAt">>,
  ): Promise<SubscriptionPlanDocument | null> {
    try {
      const col = await this.col();
      return await col.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: updates },
        { returnDocument: "after" },
      );
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      const col = await this.col();
      const r = await col.deleteOne({ _id: new ObjectId(id) });
      return r.deletedCount > 0;
    } catch {
      return false;
    }
  }
}
