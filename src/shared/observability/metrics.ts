/**
 * Prometheus metrics via `prom-client` — replaces the old hand-rolled text
 * formatter. Gets default Node.js process/GC/event-loop metrics for free via
 * `collectDefaultMetrics`, and label cardinality is bounded by prom-client
 * itself rather than growing an unbounded in-memory map per unique label set.
 */
import client from "prom-client";

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsInFlight = new client.Gauge({
  name: "http_requests_in_flight",
  help: "HTTP requests currently being processed",
  registers: [register],
});

// Spec §7.2: 0=closed, 1=open, 2=half-open. Set from CircuitBreaker's
// onStateChange hook (see circuit-breaker.ts) for each of livekit/fcm/apns —
// kept here (not in circuit-breaker.ts) so that generic utility doesn't
// depend on prom-client.
export const circuitBreakerState = new client.Gauge({
  name: "agcloud_circuit_breaker_state",
  help: "Circuit breaker state per dependency (0=closed, 1=open, 2=half-open)",
  labelNames: ["dependency"] as const,
  registers: [register],
});

const CIRCUIT_STATE_VALUE = { CLOSED: 0, OPEN: 1, HALF_OPEN: 2 } as const;

export function setCircuitBreakerState(dependency: string, state: keyof typeof CIRCUIT_STATE_VALUE): void {
  circuitBreakerState.set({ dependency }, CIRCUIT_STATE_VALUE[state]);
}

// Spec §7.2 names every business metric with an `agcloud_` prefix.
export const callsInitiated = new client.Counter({
  name: "agcloud_calls_initiated_total",
  help: "Total calls initiated",
  registers: [register],
});

export const callsAccepted = new client.Counter({
  name: "agcloud_calls_accepted_total",
  help: "Total calls accepted",
  registers: [register],
});

export const callsRejected = new client.Counter({
  name: "agcloud_calls_rejected_total",
  help: "Total calls rejected",
  registers: [register],
});

export const callsEnded = new client.Counter({
  name: "agcloud_calls_ended_total",
  help: "Total calls ended",
  registers: [register],
});

export const callsMissed = new client.Counter({
  name: "agcloud_calls_missed_total",
  help: "Total missed calls",
  registers: [register],
});

export const pushNotificationsSent = new client.Counter({
  name: "agcloud_push_notifications_sent_total",
  help: "Push notifications sent",
  labelNames: ["platform"] as const,
  registers: [register],
});

export const pushNotificationsFailed = new client.Counter({
  name: "agcloud_push_notifications_failed_total",
  help: "Push notification failures",
  labelNames: ["platform"] as const,
  registers: [register],
});

export function getMetricsContentType(): string {
  return register.contentType;
}

export async function getMetrics(): Promise<string> {
  return register.metrics();
}
