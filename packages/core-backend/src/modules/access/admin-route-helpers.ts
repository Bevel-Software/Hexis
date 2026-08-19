/**
 * SHARED route plumbing for the access-family routers (access.routes,
 * groups-admin.routes) — one error shape, one input-coercion rule, so the two
 * surfaces can't drift apart again.
 *
 * Error shape: a `WorkflowDomainError` renders as its own status + message +
 * payload; anything else is an INTERNAL error — logged server-side, answered
 * with a generic message. A raw `err.message` must never leak through a 500
 * (it can carry file paths and internals the caller has no business seeing).
 */

import type express from 'express';
import { WorkflowDomainError } from '../workflow/workflow.errors.js';

/** One error shape for every access-family route. */
export function toHttpError(
  err: unknown,
  logTag: string,
): { status: number; body: Record<string, unknown> } {
  if (err instanceof WorkflowDomainError) {
    return { status: err.status, body: { error: err.message, ...(err.payload ?? {}) } };
  }
  console.error(`[${logTag}] route failure:`, err instanceof Error ? err.stack ?? err.message : err);
  return { status: 500, body: { error: 'Internal error.' } };
}

/** Answer `res` with the shared error shape. */
export function sendError(res: express.Response, err: unknown, logTag: string): void {
  const { status, body } = toHttpError(err, logTag);
  res.status(status).json(body);
}

/**
 * Coerce a request-body field that must be a non-empty string. Rejects arrays,
 * objects, numbers, null — anything `String()` would silently stringify into a
 * bogus principal name / email (`[object Object]`, `"a,b"`) — with a 400
 * instead of persisting garbage. Returns the raw string (untrimmed by default
 * — services trim; pass `trim: true` where the route owns normalization).
 */
export function requireNonEmptyString(
  value: unknown,
  field: string,
  opts?: { trim?: boolean },
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkflowDomainError(`${field} must be a non-empty string`, 400);
  }
  return opts?.trim ? value.trim() : value;
}
