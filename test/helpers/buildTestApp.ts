import "./mockDb.js";
import "./mockLivekit.js";
import "./mockBullmq.js";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";

export async function buildTestApp(): Promise<FastifyInstance> {
  return buildApp();
}
