import dotenv from "dotenv";

dotenv.config();

const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  mongoUri: process.env.MONGO_URI ?? "mongodb://localhost:27017/agcloud",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? "",
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? "",
  livekitUrl: process.env.LIVEKIT_URL ?? "http://localhost:7880",
  jwtSecret: process.env.JWT_SECRET ?? "change-me"
};

export default config;
