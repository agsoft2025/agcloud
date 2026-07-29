/**
 * Per-request correlation context (spec §7.1: every log line should carry
 * requestId/userId/traceId/spanId). Backed by AsyncLocalStorage so the
 * ~150 existing call sites that log via the shared `logger` singleton don't
 * need to thread a request object through — `logger.ts`'s pino `mixin`
 * reads this store on every log call instead.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId?: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Starts a new context for the remainder of the current async chain (call once per request, as early as possible). */
export function enterRequestContext(context: RequestContext): void {
  storage.enterWith(context);
}

/** Mutates a field on the active context, if one exists (e.g. adding userId once auth succeeds, mid-request). */
export function setRequestContextField<K extends keyof RequestContext>(key: K, value: RequestContext[K]): void {
  const store = storage.getStore();
  if (store) store[key] = value;
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
