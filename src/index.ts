// Must be the first import — OpenTelemetry auto-instrumentation patches
// Fastify/MongoDB/ioredis/http before they're first required anywhere else.
import "./shared/observability/tracing.js";

import { startServer } from "./server.js";

// Entry point of the application
startServer();
