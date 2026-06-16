import { z } from "zod";
import { ObjectId } from "mongodb";

export const callStatusSchema = z.enum([
  "initiated",
  "active",
  "rejected",
  "ended",
  "missed",
]);

export type CallStatus = z.infer<typeof callStatusSchema>;

export const participantStatusSchema = z.enum([
  "invited",
  "joined",
  "rejected",
  "left",
  "missed",
]);

export type ParticipantStatus = z.infer<typeof participantStatusSchema>;

export const callParticipantSchema = z.object({
  status: participantStatusSchema,
  invitedAt: z.date(),
  invitedBy: z.string().optional(),
  respondedAt: z.date().optional(),
});

export type CallParticipant = z.infer<typeof callParticipantSchema>;

export const callSchema = z.object({
  callerId: z.string(), // User ID of caller (string representation of ObjectId)
  calleeId: z.string(), // User ID of callee (string representation of ObjectId, primary receiver)
  receiverIds: z.array(z.string()).default([]), // All receiver User IDs
  callMode: z.enum(["one-to-one", "conference"]).default("one-to-one"),
  roomId: z.string().optional(), // LiveKit Room ID / Name
  status: callStatusSchema.default("initiated"),
  callType: z.enum(["audio", "video"]).default("video"),
  recording: z.boolean().default(false), // Call recording active status
  // Per-receiver invitation status, keyed by userId. Tracks invite/re-invite
  // lifecycle independently from the overall call status so users can be
  // re-invited after a missed/rejected invitation while the call is ongoing.
  participants: z.record(z.string(), callParticipantSchema).default({}),
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

export const addParticipantSchema = z.object({
  userId: z.string(),
});

export type AddParticipantInput = z.infer<typeof addParticipantSchema>;
