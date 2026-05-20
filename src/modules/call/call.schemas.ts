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
  calleeId: z.string(), // User ID of callee (string representation of ObjectId)
  status: callStatusSchema.default("initiated"),
  callType: z.enum(["audio", "video"]).default("video"),
  createdAt: z.date().default(() => new Date()),
  startedAt: z.date().optional(), // When call was accepted
  endedAt: z.date().optional(), // When call was hung up / ended
});

export type Call = z.infer<typeof callSchema>;

export interface CallDocument extends Call {
  _id: ObjectId;
}

export const initCallSchema = z.object({
  calleeId: z.string(),
  callType: z.enum(["audio", "video"]).default("video"),
});

export type InitCallInput = z.infer<typeof initCallSchema>;
