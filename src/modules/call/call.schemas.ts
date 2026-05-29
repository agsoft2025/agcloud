import { z } from "zod";
import { ObjectId } from "mongodb";

export const callStatusSchema = z.enum([
  "initiated",
  "active",
  "rejected",
  "ended",
]);

export type CallStatus = z.infer<typeof callStatusSchema>;

export const callSchema = z.object({
  callerId: z.string(), // User ID of caller (string representation of ObjectId)
  calleeId: z.string(), // User ID of callee (string representation of ObjectId, primary receiver)
  receiverIds: z.array(z.string()).default([]), // All receiver User IDs
  callMode: z.enum(["one-to-one", "conference"]).default("one-to-one"),
  roomId: z.string().optional(), // LiveKit Room ID / Name
  status: callStatusSchema.default("initiated"),
  callType: z.enum(["audio", "video"]).default("video"),
  recording: z.boolean().default(false), // Call recording active status
  createdAt: z.date().default(() => new Date()),
  startedAt: z.date().optional(), // When call was accepted
  endedAt: z.date().optional(), // When call was hung up / ended
  recordingStartedAt: z.date().optional(),
  recordingEndedAt: z.date().optional(),
  egressId: z.string().optional(), // LiveKit Egress (recording) ID
  recordingUrl: z.string().optional(), // Recording file URL
});

export type Call = z.infer<typeof callSchema>;

export interface CallDocument extends Call {
  _id: ObjectId;
}

export const initCallSchema = z.object({
  calleeId: z.string().optional(), // optional for backward compatibility
  receiverIds: z.array(z.string()).optional(), // optional list of receiver user IDs
  callType: z.enum(["audio", "video"]).default("video"),
  callMode: z.enum(["one-to-one", "conference"]).default("one-to-one"),
  recording: z.boolean().default(false),
});

export type InitCallInput = z.infer<typeof initCallSchema>;
