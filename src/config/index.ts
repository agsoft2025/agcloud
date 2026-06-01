import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.string().default("3001").transform(Number),
  MONGO_URI: z.string().default("mongodb://localhost:27017/agcloud"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  LIVEKIT_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  FRONTEND_URL: z.string().default("http://localhost:5173").transform(val => val.split(",").map(s => s.trim())),
  JWT_ACCESS_TOKEN_EXPIRES_IN: z.string().default("7d"),
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
  jwtSecret: envVars.JWT_SECRET,
  frontendUrl: envVars.FRONTEND_URL,
  jwtAccessTokenExpiresIn: envVars.JWT_ACCESS_TOKEN_EXPIRES_IN,
};

export default config;
