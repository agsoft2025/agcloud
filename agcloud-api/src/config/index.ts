import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().default("3000"),
  MONGO_URI: z.string().default("mongodb://localhost:27017/agcloud"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  LIVEKIT_API_KEY: z.string().min(1, "LIVEKIT_API_KEY is required"),
  LIVEKIT_API_SECRET: z.string().min(1, "LIVEKIT_API_SECRET is required"),
  LIVEKIT_URL: z.string().default("http://localhost:7880"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  port: parseInt(parsed.data.PORT, 10),
  mongoUri: parsed.data.MONGO_URI,
  redisUrl: parsed.data.REDIS_URL,
  livekit: {
    apiKey: parsed.data.LIVEKIT_API_KEY,
    apiSecret: parsed.data.LIVEKIT_API_SECRET,
    url: parsed.data.LIVEKIT_URL,
  },
  jwtSecret: parsed.data.JWT_SECRET,
} as const;

export default config;
