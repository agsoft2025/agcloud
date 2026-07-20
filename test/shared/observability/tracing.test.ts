import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const startMock = vi.fn();
const shutdownMock = vi.fn().mockResolvedValue(undefined);
const nodeSdkCtor = vi.fn(function (this: { start: typeof startMock; shutdown: typeof shutdownMock }) {
  this.start = startMock;
  this.shutdown = shutdownMock;
  return this;
});

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: nodeSdkCtor,
}));

vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: vi.fn().mockReturnValue([]),
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: vi.fn(function (this: unknown) {
    return this;
  }),
}));

describe("tracing (OpenTelemetry SDK bootstrap)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    nodeSdkCtor.mockClear();
    startMock.mockClear();
    shutdownMock.mockClear();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("does not construct or start the SDK when OTEL_EXPORTER_OTLP_ENDPOINT is unset", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    await import("../../../src/shared/observability/tracing.js");

    expect(nodeSdkCtor).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("constructs and starts the SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    await import("../../../src/shared/observability/tracing.js");

    expect(nodeSdkCtor).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("points the trace exporter at the /v1/traces path under the configured endpoint", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318/";
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    await import("../../../src/shared/observability/tracing.js");

    expect(OTLPTraceExporter).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://collector:4318/v1/traces" })
    );
  });
});
