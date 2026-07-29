/**
 * Structured logger — a single pino instance shared by both application code
 * and Fastify (passed into `Fastify({ logger })` in app.ts) so there is one
 * logging pipeline, not a hand-rolled one duplicating Fastify's internal pino.
 */
import pino from "pino";
import { trace } from "@opentelemetry/api";
import { getRequestContext } from "./request-context.js";

const level =
  process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");

/** Exported (not just used inline below) so tests can build a pino instance against a custom stream and assert on actual redacted/mixed-in output. */
export const pinoOptions: pino.LoggerOptions = {
  level,
  base: {
    service: "agcloud-backend",
    version: process.env.npm_package_version ?? "0.1.0",
    env: process.env.NODE_ENV ?? "development",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Spec §7.1: requestId/userId (per-request, via AsyncLocalStorage — see
  // request-context.ts) and traceId/spanId (from the active OpenTelemetry
  // span, if tracing is enabled) on every log line, without threading
  // request/span objects through the ~150 existing call sites that log via
  // this singleton. `mixin` runs on every call and is a no-op object merge
  // when neither context is present (local dev without a collector, or code
  // running outside a request).
  mixin() {
    const ctx = getRequestContext();
    const spanContext = trace.getActiveSpan()?.spanContext();
    return {
      ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
      ...(ctx?.userId ? { userId: ctx.userId } : {}),
      ...(spanContext ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : {}),
    };
  },
  // Spec §7.1: PII/secrets must never reach the log sink even if a future
  // call site accidentally logs a raw request, body, or user object.
  redact: {
    paths: ["req.headers.authorization", "req.body.password", "user.email"],
    censor: "[REDACTED]",
  },
};

const logger = pino(pinoOptions);

export type Logger = pino.Logger;
export default logger;
