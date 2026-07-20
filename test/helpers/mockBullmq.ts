import { vi } from "vitest";

// Import before anything that transitively imports "bullmq" (call.queue.ts).
// call.queue.ts also opens a dedicated ioredis connection per Queue/Worker
// via createDedicatedRedisConnection() — mockDb.ts's redis.client.js mock
// covers that half; this covers BullMQ itself, which otherwise issues real
// Lua/stream commands the FakeRedis doesn't implement.
export const bullmqMocks = {
  add: vi.fn().mockResolvedValue(undefined),
  getJob: vi.fn().mockResolvedValue(null),
  jobRemove: vi.fn().mockResolvedValue(undefined),
  queueClose: vi.fn().mockResolvedValue(undefined),
  workerClose: vi.fn().mockResolvedValue(undefined),
  // The last processor function passed to `new Worker(name, processor, opts)`
  // — lets tests invoke a queue's job handler directly without a real broker.
  lastWorkerProcessor: null as ((job: unknown) => Promise<unknown>) | null,
};

export function resetBullmqMocks(): void {
  bullmqMocks.add.mockClear().mockResolvedValue(undefined);
  bullmqMocks.getJob.mockClear().mockResolvedValue(null);
  bullmqMocks.jobRemove.mockClear().mockResolvedValue(undefined);
  bullmqMocks.queueClose.mockClear().mockResolvedValue(undefined);
  bullmqMocks.workerClose.mockClear().mockResolvedValue(undefined);
  bullmqMocks.lastWorkerProcessor = null;
}

vi.mock("bullmq", () => {
  class Queue {
    constructor(_name?: string, _opts?: unknown) {}
    add(...args: unknown[]) {
      return bullmqMocks.add(...args);
    }
    async getJob(...args: unknown[]) {
      const job = await bullmqMocks.getJob(...args);
      if (!job) return null;
      return { ...job, remove: bullmqMocks.jobRemove };
    }
    close() {
      return bullmqMocks.queueClose();
    }
  }
  class Worker {
    constructor(_name?: string, processor?: (job: unknown) => Promise<unknown>, _opts?: unknown) {
      bullmqMocks.lastWorkerProcessor = processor ?? null;
    }
    on(_event: string, _handler: (...args: unknown[]) => void) {}
    close() {
      return bullmqMocks.workerClose();
    }
  }
  return { Queue, Worker };
});
