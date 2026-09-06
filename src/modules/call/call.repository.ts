import { ObjectId } from "mongodb";
import { connectMongo } from "../../shared/db/mongo.client.js";
import logger from "../../shared/observability/logger.js";
import {
  CallDocument,
  Call,
  CallStatus,
  CallParticipant,
  ParticipantStatus,
} from "./call.schemas.js";

/**
 * Thrown by createCall() when the `caller_active` unique index (see
 * mongo.client.ts) rejects a second concurrent insert for a caller who
 * already has an active/initiated call — the DB-level backstop for the
 * "simultaneous initiation" race (spec §10.2), since the earlier
 * `getActiveCallForUser` read-then-write check alone can't prevent two
 * requests racing each other.
 */
export class DuplicateActiveCallError extends Error {}

function isMongoDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

export class CallRepository {
  private async getCollection() {
    const db = await connectMongo();
    return db.collection<CallDocument>("calls");
  }

  async createCall(
    callerId: string,
    receiverIds: string[],
    callType: "audio" | "video",
    callMode: "one-to-one" | "conference",
    recording = false
  ): Promise<CallDocument> {
    const collection = await this.getCollection();
    const calleeId = receiverIds[0] || "";

    const now = new Date();
    const participants: Record<string, CallParticipant> = {};
    for (const receiverId of receiverIds) {
      participants[receiverId] = { status: "invited", invitedAt: now, invitedBy: callerId };
    }

    const newCall: Call = {
      callerId,
      calleeId,
      receiverIds,
      callMode,
      status: "initiated",
      callType,
      recording,
      participants,
      createdAt: now,
    };

    let result;
    try {
      result = await collection.insertOne(newCall as CallDocument);
    } catch (err) {
      if (isMongoDuplicateKeyError(err)) {
        throw new DuplicateActiveCallError(
          `Caller ${callerId} already has an active call (concurrent initiate)`
        );
      }
      throw err;
    }
    const generatedCallId = result.insertedId.toString();

    // Set roomId to the generated MongoDB Call _id string for simplicity and uniqueness
    await collection.updateOne({ _id: result.insertedId }, { $set: { roomId: generatedCallId } });

    newCall.roomId = generatedCallId;

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
      logger.error({ err: error, callId: id }, "getCallById failed");
      return null;
    }
  }

  async updateCallStatus(
    id: string,
    status: CallStatus,
    extra?: Partial<CallDocument>
  ): Promise<boolean> {
    const collection = await this.getCollection();
    const updatePayload: any = { status };

    if (status === "active") {
      updatePayload.startedAt = new Date();
    } else if (
      status === "rejected" ||
      status === "ended" ||
      status === "cancelled" ||
      status === "missed"
    ) {
      updatePayload.endedAt = new Date();
    }

    if (extra) {
      Object.assign(updatePayload, extra);
    }

    try {
      const result = await collection.updateOne({ _id: new ObjectId(id) }, { $set: updatePayload });
      return result.modifiedCount > 0;
    } catch {
      return false;
    }
  }

  async getCallHistoryForUser(userId: string, limit = 20): Promise<CallDocument[]> {
    const collection = await this.getCollection();
    return await collection
      .find({
        $or: [{ callerId: userId }, { calleeId: userId }, { receiverIds: userId }],
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async addParticipant(callId: string, userId: string): Promise<CallDocument | null> {
    const collection = await this.getCollection();
    try {
      await collection.updateOne(
        { _id: new ObjectId(callId) },
        {
          $addToSet: { receiverIds: userId },
          $set: { callMode: "conference" },
        }
      );
      return await collection.findOne({ _id: new ObjectId(callId) });
    } catch (error) {
      logger.error({ err: error, callId }, "addParticipant failed");
      return null;
    }
  }

  /**
   * Invite (or re-invite) a user to a call. Adds them to receiverIds if
   * needed and (re)sets their participant entry to "invited" so a
   * previously missed/rejected/left user can receive a fresh invitation.
   */
  async inviteParticipant(
    callId: string,
    userId: string,
    invitedBy: string
  ): Promise<CallDocument | null> {
    const collection = await this.getCollection();
    try {
      await collection.updateOne(
        { _id: new ObjectId(callId) },
        {
          $addToSet: { receiverIds: userId },
          $set: {
            callMode: "conference",
            [`participants.${userId}`]: {
              status: "invited",
              invitedAt: new Date(),
              invitedBy,
            },
          },
        }
      );
      return await collection.findOne({ _id: new ObjectId(callId) });
    } catch (error) {
      logger.error({ err: error, callId }, "inviteParticipant failed");
      return null;
    }
  }

  async setParticipantStatus(
    callId: string,
    userId: string,
    status: ParticipantStatus
  ): Promise<boolean> {
    const collection = await this.getCollection();
    try {
      const result = await collection.updateOne(
        { _id: new ObjectId(callId) },
        {
          $set: {
            [`participants.${userId}.status`]: status,
            [`participants.${userId}.respondedAt`]: new Date(),
          },
        }
      );
      return result.modifiedCount > 0;
    } catch (error) {
      logger.error({ err: error, callId }, "setParticipantStatus failed");
      return false;
    }
  }

  /** Mark every participant still in "invited" status as `status` (e.g. "missed" when the call ends, "cancelled" when the caller cancels pre-pickup). */
  async markPendingParticipantsAs(callId: string, status: ParticipantStatus): Promise<void> {
    const collection = await this.getCollection();
    const call = await collection.findOne({ _id: new ObjectId(callId) });
    if (!call?.participants) return;

    const updates: Record<string, ParticipantStatus> = {};
    for (const [userId, participant] of Object.entries(call.participants)) {
      if (participant.status === "invited") {
        updates[`participants.${userId}.status`] = status;
      }
    }

    if (Object.keys(updates).length === 0) return;

    try {
      await collection.updateOne({ _id: new ObjectId(callId) }, { $set: updates });
    } catch (error) {
      logger.error({ err: error, callId }, "markPendingParticipantsAs failed");
    }
  }

  async getActiveCallForUser(userId: string): Promise<CallDocument | null> {
    const collection = await this.getCollection();
    return await collection.findOne({
      $or: [{ callerId: userId }, { calleeId: userId }, { receiverIds: userId }],
      status: { $in: ["initiated", "active"] },
    });
  }

  /** Returns calls that are still active/initiated where this user was invited
   *  but hasn't yet joined — used to re-notify users who come back online. */
  async getActivePendingCallsForUser(userId: string): Promise<CallDocument[]> {
    const collection = await this.getCollection();
    return await collection
      .find({
        receiverIds: userId,
        status: { $in: ["initiated", "active"] },
        [`participants.${userId}.status`]: { $in: ["invited", "missed"] },
      })
      .toArray();
  }

  /**
   * Aggregate actual call durations by caller from the `calls` collection.
   *
   * Uses ended calls that have both `startedAt` and `endedAt` set — this is
   * the only reliable source for subscribed-user durations, because billing
   * timers (and therefore `call_charges` records) are skipped for them.
   *
   * Returns a map keyed by callerId with split audio/video seconds.
   */
  async findDurationGroupedByCaller(): Promise<
    Map<string, { audioSeconds: number; videoSeconds: number }>
  > {
    const collection = await this.getCollection();

    const pipeline = [
      {
        $match: {
          status:    "ended",
          startedAt: { $exists: true, $ne: null },
          endedAt:   { $exists: true, $ne: null },
        },
      },
      {
        $addFields: {
          // Mongo dates are stored as BSON Date; subtract gives ms.
          durationSec: {
            $max: [
              0,
              { $divide: [{ $subtract: ["$endedAt", "$startedAt"] }, 1000] },
            ],
          },
        },
      },
      {
        $group: {
          _id: "$callerId",
          audioSeconds: {
            $sum: {
              $cond: [{ $eq: ["$callType", "audio"] }, "$durationSec", 0],
            },
          },
          videoSeconds: {
            $sum: {
              $cond: [{ $eq: ["$callType", "video"] }, "$durationSec", 0],
            },
          },
        },
      },
    ];

    const results = await collection
      .aggregate<{ _id: string; audioSeconds: number; videoSeconds: number }>(pipeline)
      .toArray();

    const map = new Map<string, { audioSeconds: number; videoSeconds: number }>();
    for (const r of results) {
      map.set(r._id, { audioSeconds: r.audioSeconds, videoSeconds: r.videoSeconds });
    }
    return map;
  }

  /** Admin view: every call currently ringing or in progress, newest first, paginated. */
  async getActiveCalls(
    page: number,
    limit: number
  ): Promise<{ calls: CallDocument[]; total: number }> {
    const collection = await this.getCollection();
    const filter = { status: { $in: ["initiated", "active"] as CallStatus[] } };

    const [calls, total] = await Promise.all([
      collection
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      collection.countDocuments(filter),
    ]);

    return { calls, total };
  }
}
