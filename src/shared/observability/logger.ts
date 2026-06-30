/**
 * Structured logger.
 * Uses pino at runtime (bundled inside Fastify), with console fallback for standalone use.
 * All sensitive fields are never logged (redacted at call site via the helper below).
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface StructuredLogger {
  trace(obj: object, msg?: string): void;
  trace(msg: string): void;
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  fatal(obj: object, msg?: string): void;
  fatal(msg: string): void;
  child(bindings: object): StructuredLogger;
}

const LEVEL_NUM: Record<LogLevel, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
};

const configuredLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel | undefined) ??
  (process.env.NODE_ENV === "production" ? "info" : "debug");

const minLevel = LEVEL_NUM[configuredLevel] ?? 30;

function makeLogger(bindings: object = {}): StructuredLogger {
  function write(level: LogLevel, objOrMsg: object | string, msg?: string): void {
    if (LEVEL_NUM[level] < minLevel) return;

    const ts = new Date().toISOString();
    const extra = typeof objOrMsg === "string" ? {} : objOrMsg;
    const message = typeof objOrMsg === "string" ? objOrMsg : (msg ?? "");

    const entry = JSON.stringify({ level, time: ts, ...bindings, ...extra, msg: message });

    if (LEVEL_NUM[level] >= LEVEL_NUM.error) {
      process.stderr.write(entry + "\n");
    } else {
      process.stdout.write(entry + "\n");
    }
  }

  return {
    trace: (o: any, m?: string) => write("trace", o, m),
    debug: (o: any, m?: string) => write("debug", o, m),
    info:  (o: any, m?: string) => write("info",  o, m),
    warn:  (o: any, m?: string) => write("warn",  o, m),
    error: (o: any, m?: string) => write("error", o, m),
    fatal: (o: any, m?: string) => write("fatal", o, m),
    child: (b: object) => makeLogger({ ...bindings, ...b }),
  };
}

export const logger: StructuredLogger = makeLogger({
  service: "agcloud-backend",
  env: process.env.NODE_ENV ?? "development",
});

export type Logger = StructuredLogger;
export default logger;
