// Runs before every test file. Ensures src/config/index.ts (which parses
// process.env with Zod at import time) always has valid values, regardless
// of whether a developer .env is present. dotenv.config() (called inside
// config/index.ts) does not override already-set process.env vars, so these
// take precedence over any real .env file.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ??= "test_jwt_secret_at_least_32_characters_long_______";
process.env.JWT_REFRESH_SECRET ??= "test_jwt_refresh_secret_at_least_32_characters___";
process.env.LIVEKIT_API_KEY ??= "test-livekit-api-key";
process.env.LIVEKIT_API_SECRET ??= "test-livekit-api-secret";
process.env.LIVEKIT_URL ??= "wss://test.livekit.cloud";
process.env.MONGO_URI ??= "mongodb://127.0.0.1:27017/agcloud_test";
process.env.REDIS_URL ??= "redis://127.0.0.1:6379/1";
process.env.FRONTEND_URL ??= "http://localhost:5173";
process.env.LOG_LEVEL = "fatal";
