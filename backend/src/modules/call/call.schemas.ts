import { z } from "zod";

export const initCallSchema = z.object({
  calleeId: z.string().uuid(),
  callType: z.enum(["audio", "video"]).default("video")
});

export type InitCallInput = z.infer<typeof initCallSchema>;
