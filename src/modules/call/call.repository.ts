import { ObjectId } from "mongodb";
import { connectMongo } from "../../shared/db/mongo.client.js";
import { CallDocument, Call, CallStatus } from "./call.schemas.js";

export class CallRepository {
  private async getCollection() {
    const db = await connectMongo();
    return db.collection<CallDocument>("calls");
  }

  async createCall(callerId: string, calleeId: string, callType: "audio" | "video"): Promise<CallDocument> {
    const collection = await this.getCollection();
    const newCall: Call = {
      callerId,
      calleeId,
      status: "initiated",
      callType,
      createdAt: new Date(),
    };

    const result = await collection.insertOne(newCall as CallDocument);
    return {
      _id: result.insertedId,
      ...newCall,
    } as CallDocument;
  }

  async getCallById(id: string): Promise<CallDocument | null> {
    const collection = await this.getCollection();
    try {
      return await collection.findOne({ _id: new ObjectId(id) });
    } catch (error) {
      console.error(`Error in getCallById for id "${id}":`, error);
      return null;
    }
  }

  async updateCallStatus(id: string, status: CallStatus, extra?: Partial<CallDocument>): Promise<boolean> {
    const collection = await this.getCollection();
    const updatePayload: any = { status };

    if (status === "active") {
      updatePayload.startedAt = new Date();
    } else if (status === "rejected" || status === "ended") {
      updatePayload.endedAt = new Date();
    }

    if (extra) {
      Object.assign(updatePayload, extra);
    }

    try {
      const result = await collection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatePayload }
      );
      return result.modifiedCount > 0;
    } catch {
      return false;
    }
  }

  async getActiveCallForUser(userId: string): Promise<CallDocument | null> {
    const collection = await this.getCollection();
    return await collection.findOne({
      $or: [{ callerId: userId }, { calleeId: userId }],
      status: { $in: ["initiated", "active"] },
    });
  }
}
