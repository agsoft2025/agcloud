import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.string().default("3000").transform(Number),
  MONGO_URI: z.string().default("mongodb://localhost:27017/agcloud"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  LIVEKIT_URL: z.string().url(),
  LIVEKIT_PUBLIC_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  JWT_ACCESS_TOKEN_EXPIRES_IN: z.string().default("15m"),
  FRONTEND_URL: z
    .string()
    .default("http://localhost:5173")
    .transform((val) => val.split(",").map((s) => s.trim())),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().optional(),
  FCM_PRIVATE_KEY: z.string().optional(),
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_PRIVATE_KEY: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(),
  APNS_PRODUCTION: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});

const envVars = envSchema.parse(process.env);

const config = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  mongoUri: envVars.MONGO_URI,
  redisUrl: envVars.REDIS_URL,
  livekitApiKey: envVars.LIVEKIT_API_KEY,
  livekitApiSecret: envVars.LIVEKIT_API_SECRET,
  livekitUrl: envVars.LIVEKIT_URL,
  livekitPublicUrl: envVars.LIVEKIT_PUBLIC_URL,
  jwtSecret: envVars.JWT_SECRET,
  jwtRefreshSecret: envVars.JWT_REFRESH_SECRET ?? envVars.JWT_SECRET,
  jwtAccessTokenExpiresIn: envVars.JWT_ACCESS_TOKEN_EXPIRES_IN,
  frontendUrl: envVars.FRONTEND_URL,
  logLevel: envVars.LOG_LEVEL,
};

export default config;
