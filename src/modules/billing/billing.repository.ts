import { connectMongo } from "../../shared/db/mongo.client.js";
import type { CallChargeDocument } from "./billing.schemas.js";

export class BillingRepository {
  private async col() {
    const db = await connectMongo();
    return db.collection<CallChargeDocument>("call_charges");
  }

  async create(charge: Omit<CallChargeDocument, "_id">): Promise<CallChargeDocument> {
    const col = await this.col();
    const result = await col.insertOne(charge as CallChargeDocument);
    return { ...charge, _id: result.insertedId };
  }

  async findByCallId(callId: string): Promise<CallChargeDocument | null> {
    const col = await this.col();
    return col.findOne({ callId });
  }

  async findAll(
    page = 1,
    limit = 20,
  ): Promise<{ charges: CallChargeDocument[]; total: number }> {
    const col = await this.col();
    const skip = (page - 1) * limit;
    const [charges, total] = await Promise.all([
      col.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      col.countDocuments(),
    ]);
    return { charges, total };
  }
}
