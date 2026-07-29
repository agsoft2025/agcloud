/* eslint-disable no-console -- this file must be side-effect-free of any
   other module's import graph until `sdk.start()` runs (see below), so it
   deliberately does not pull in the shared pino logger the rest of the app
   uses; that import-order guarantee is worth more here than log consistency. */
/**
 * OpenTelemetry distributed tracing.
 *
 * MUST be the first import in the process (see src/index.ts) — auto
 * instrumentation patches Node's module loader for Fastify/MongoDB/ioredis/
 * outbound HTTP, so it has to run before those libraries are first
 * `require`'d anywhere in the dependency graph.
 *
 * No-ops unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so local dev/CI without a
 * collector running doesn't pay any startup cost or spam connection errors.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

let sdk: NodeSDK | null = null;

if (otlpEndpoint) {
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "agcloud-backend",
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.1.0",
    }),
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint.replace(/\/$/, "")}/v1/traces` }),
    // Fastify sits directly on Node's http server, so instrumentation-http
    // (bundled below) already captures every request/response span —
    // there's no separate Fastify-specific instrumentation package. Combined
    // with instrumentation-mongodb and instrumentation-ioredis (also
    // bundled), this correlates traces across all three of this app's
    // external dependencies (HTTP in, Mongo, Redis) plus outbound HTTP calls
    // to LiveKit/FCM/APNs.
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-http": {
          // The liveness probe fires every few seconds and is noise, not a trace worth keeping.
          ignoreIncomingRequestHook: (req) => req.url === "/live" || req.url === "/health/live",
        },
        // fs instrumentation is extremely high-volume and rarely useful for an API server.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();

  process.on("SIGTERM", () => void sdk?.shutdown().catch(() => {}));
  process.on("SIGINT", () => void sdk?.shutdown().catch(() => {}));

  console.log("[tracing] OpenTelemetry SDK started, exporting to", otlpEndpoint);
} else {
  console.log("[tracing] OTEL_EXPORTER_OTLP_ENDPOINT not set — tracing disabled");
}
