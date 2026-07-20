/**
 * Structured logger — a single pino instance shared by both application code
 * and Fastify (passed into `Fastify({ logger })` in app.ts) so there is one
 * logging pipeline, not a hand-rolled one duplicating Fastify's internal pino.
 */
import pino from "pino";

const level =
  process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");

const logger = pino({
  level,
  base: {
    service: "agcloud-backend",
    env: process.env.NODE_ENV ?? "development",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = pino.Logger;
export default logger;
