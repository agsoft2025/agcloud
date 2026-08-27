import { ObjectId } from "mongodb";
import { connectMongo } from "../../shared/db/mongo.client.js";
import type { PricingRateDocument } from "./pricing.schemas.js";

export class PricingRepository {
  private async col() {
    const db = await connectMongo();
    return db.collection<PricingRateDocument>("call_pricing");
  }

  async create(rate: Omit<PricingRateDocument, "_id">): Promise<PricingRateDocument> {
    const col = await this.col();
    const result = await col.insertOne(rate as PricingRateDocument);
    return { ...rate, _id: result.insertedId };
  }

  async findById(id: string): Promise<PricingRateDocument | null> {
    try {
      const col = await this.col();
      return await col.findOne({ _id: new ObjectId(id) });
    } catch {
      return null;
    }
  }

  async findAll(): Promise<PricingRateDocument[]> {
    const col = await this.col();
    return col.find({}).sort({ callType: 1, effectiveFrom: -1 }).toArray();
  }

  /**
   * Return the rate in effect for `callType` at the given moment.
   * "In effect" = the rate with the highest effectiveFrom that is <= asOf.
   */
  async findActiveRate(
    callType: "audio" | "video",
    asOf: Date = new Date(),
  ): Promise<PricingRateDocument | null> {
    const col = await this.col();
    return col.findOne(
      { callType, effectiveFrom: { $lte: asOf } },
      { sort: { effectiveFrom: -1 } },
    );
  }

  async update(
    id: string,
    updates: Partial<Pick<PricingRateDocument, "ratePerMinute" | "effectiveFrom" | "label">>,
  ): Promise<PricingRateDocument | null> {
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
