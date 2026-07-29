import { describe, it, expect, beforeEach } from "vitest";
import {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
  callsInitiated,
  callsMissed,
  pushNotificationsSent,
  pushNotificationsFailed,
  setCircuitBreakerState,
  getMetrics,
  getMetricsContentType,
} from "../../../src/shared/observability/metrics.js";

describe("metrics (prom-client)", () => {
  beforeEach(() => {
    register.resetMetrics();
  });

  it("increments a labelled counter and reflects it in getMetrics()", async () => {
    httpRequestsTotal.inc({ method: "GET", route: "/x", status_code: "200" });
    httpRequestsTotal.inc({ method: "GET", route: "/x", status_code: "200" });
    httpRequestsTotal.inc({ method: "GET", route: "/x", status_code: "500" });

    const output = await getMetrics();
    expect(output).toContain("# TYPE http_requests_total counter");
    expect(output).toContain('http_requests_total{method="GET",route="/x",status_code="200"} 2');
    expect(output).toContain('http_requests_total{method="GET",route="/x",status_code="500"} 1');
  });

  it("increments an unlabelled counter (agcloud_calls_initiated_total)", async () => {
    callsInitiated.inc();
    callsInitiated.inc();

    const output = await getMetrics();
    expect(output).toContain("agcloud_calls_initiated_total 2");
  });

  it("supports .inc() with no labels on agcloud_calls_missed_total, matching call.queue.ts's usage", async () => {
    callsMissed.inc();
    const output = await getMetrics();
    expect(output).toContain("agcloud_calls_missed_total 1");
  });

  it("records histogram observations with bucket/sum/count lines", async () => {
    httpRequestDuration.observe({ method: "GET", route: "/x", status_code: "200" }, 0.05);
    httpRequestDuration.observe({ method: "GET", route: "/x", status_code: "200" }, 0.2);

    const output = await getMetrics();
    expect(output).toContain("# TYPE http_request_duration_seconds histogram");
    expect(output).toContain('http_request_duration_seconds_count{method="GET",route="/x",status_code="200"} 2');
  });

  it("tracks push notification counters per platform", async () => {
    pushNotificationsSent.inc({ platform: "fcm" });
    pushNotificationsFailed.inc({ platform: "apns" });

    const output = await getMetrics();
    expect(output).toContain('agcloud_push_notifications_sent_total{platform="fcm"} 1');
    expect(output).toContain('agcloud_push_notifications_failed_total{platform="apns"} 1');
  });

  it("tracks HTTP requests currently in flight", async () => {
    httpRequestsInFlight.inc();
    httpRequestsInFlight.inc();
    httpRequestsInFlight.dec();

    const output = await getMetrics();
    expect(output).toContain("# TYPE http_requests_in_flight gauge");
    expect(output).toContain("http_requests_in_flight 1");
  });

  it("tracks circuit breaker state per dependency (0=closed, 1=open, 2=half-open)", async () => {
    setCircuitBreakerState("livekit", "CLOSED");
    setCircuitBreakerState("fcm", "OPEN");
    setCircuitBreakerState("apns", "HALF_OPEN");

    const output = await getMetrics();
    expect(output).toContain('agcloud_circuit_breaker_state{dependency="livekit"} 0');
    expect(output).toContain('agcloud_circuit_breaker_state{dependency="fcm"} 1');
    expect(output).toContain('agcloud_circuit_breaker_state{dependency="apns"} 2');
  });

  it("includes default Node.js process metrics via collectDefaultMetrics", async () => {
    const output = await getMetrics();
    // collectDefaultMetrics() registers process-level gauges/counters on the
    // shared registry — process_cpu_user_seconds_total is one of the stable ones.
    expect(output).toContain("process_cpu_user_seconds_total");
  });

  it("returns the Prometheus text exposition content type", () => {
    expect(getMetricsContentType()).toBe("text/plain; version=0.0.4; charset=utf-8");
  });
});
