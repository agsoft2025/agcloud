import { ObjectId } from "mongodb";
import { connectMongo } from "../../shared/db/mongo.client.js";
import type { UserSubscriptionDocument } from "./subscription.schemas.js";

export class UserSubscriptionRepository {
  private async col() {
    const db = await connectMongo();
    return db.collection<UserSubscriptionDocument>("user_subscriptions");
  }

  async create(doc: Omit<UserSubscriptionDocument, "_id">): Promise<UserSubscriptionDocument> {
    const col = await this.col();
    const result = await col.insertOne(doc as UserSubscriptionDocument);
    return { ...doc, _id: result.insertedId };
  }

  async findByOrderId(razorpayOrderId: string): Promise<UserSubscriptionDocument | null> {
    const col = await this.col();
    return col.findOne({ razorpayOrderId });
  }

  async findActiveByUserId(userId: string): Promise<UserSubscriptionDocument | null> {
    const col = await this.col();
    const now = new Date();
    return col.findOne(
      { userId, status: "active", endDate: { $gt: now } },
      { sort: { endDate: -1 } },
    );
  }

  async findLatestByUserId(userId: string): Promise<UserSubscriptionDocument | null> {
    const col = await this.col();
    return col.findOne({ userId }, { sort: { createdAt: -1 } });
  }

  async findAllByUserId(userId: string): Promise<UserSubscriptionDocument[]> {
    const col = await this.col();
    return col.find({ userId }).sort({ createdAt: -1 }).toArray();
  }

  async activate(
    id: ObjectId,
    opts: {
      razorpayPaymentId: string;
      razorpaySignature: string;
      startDate: Date;
      endDate: Date;
    },
  ): Promise<UserSubscriptionDocument | null> {
    const col = await this.col();
    return col.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          status:            "active",
          razorpayPaymentId: opts.razorpayPaymentId,
          razorpaySignature: opts.razorpaySignature,
          startDate:         opts.startDate,
          endDate:           opts.endDate,
          updatedAt:         new Date(),
        },
      },
      { returnDocument: "after" },
    );
  }

  /** Mark subscriptions whose endDate has passed as expired. */
  async expireOverdue(): Promise<number> {
    const col = await this.col();
    const r = await col.updateMany(
      { status: "active", endDate: { $lt: new Date() } },
      { $set: { status: "expired", updatedAt: new Date() } },
    );
    return r.modifiedCount;
  }
}
