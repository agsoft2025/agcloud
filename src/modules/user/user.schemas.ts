import { z } from "zod";
import { ObjectId } from "mongodb";

export const userSchema = z.object({
  email: z.string().email(),
  emailVerified: z.boolean().default(false),
  passwordHash: z.string(),
  displayName: z.string().min(1, "Display name is required"),
  avatarUrl: z.string().url().optional(),
  phoneNumber: z.string().optional(),
  role: z.enum([
    "user",
    "admin",
    "moderator",
    "support",
  ]).default("user"),
  status: z.enum(["active", "suspended", "deleted"]).default("active"),
  preferences: z.object({
    notifications: z.object({
      calls: z.boolean().default(true),
      missedCalls: z.boolean().default(true),
    }).default({ calls: true, missedCalls: true }),
    privacy: z.object({
      allowCallsFrom: z.enum(["contacts", "anyone"]).default("anyone"),
    }).default({ allowCallsFrom: "anyone" }),
  }).default({
    notifications: { calls: true, missedCalls: true },
    privacy: { allowCallsFrom: "anyone" }
  }),
  resetPasswordToken: z.string().optional(),
  resetPasswordExpires: z.date().optional(),
  createdAt: z.date().default(() => new Date()),
  updatedAt: z.date().default(() => new Date()),
  lastSeenAt: z.date().default(() => new Date()),
});

export type User = z.infer<typeof userSchema>;

export interface UserDocument extends User {
  _id: ObjectId;
}
