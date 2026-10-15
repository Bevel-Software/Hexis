import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestAudit } from '../audit/request-audit.js';

/**
 * What ONE MCP request brings to the tool client it runs on: the bearer its
 * loopback calls carry, and the Audit log's view of it.
 *
 * The client is cached across requests (see {@link SurfaceCache}), so neither
 * may live on the client. A connection-key request's loopback bearer is its
 * own key — per-key metering rides on it, and a revoked key must stop working
 * on its very next request even while the person's client is warm. An OAuth
 * or session request's bearer is an internal token minted for that request,
 * with a lifetime: baked into a cached client it would outlive nothing and
 * expire under a page kept open for a day. So the client reads both from
 * here, at call time, and a request supplies its own.
 */
export interface McpRequestContext {
  /** The bearer this request's loopback calls carry (`${CONNECTION_KEY}` of every platform-hosted manual). */
  loopbackBearer: string;
  /** The request's Audit log view, or null when the request is attributed to nothing. */
  audit: RequestAudit | null;
}

const storage = new AsyncLocalStorage<McpRequestContext>();

/** Run `fn` as part of the request `ctx`: every tool call it makes, however deep, reads `ctx`. */
export function runInRequest<T>(ctx: McpRequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The request the current call belongs to, or undefined outside one. */
export function currentRequest(): McpRequestContext | undefined {
  return storage.getStore();
}
