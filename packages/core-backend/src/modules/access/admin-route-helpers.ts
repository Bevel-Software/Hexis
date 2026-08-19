/**
 * SHARED route plumbing for the access-family routers (access.routes,
 * groups-admin.routes) — one error shape, one input-coercion rule, so the two
 * surfaces can't drift apart again.
 *
 * Error shape: a sub-500 `WorkflowDomainError` renders as its own status +
 * message + payload; everything else — a raw error OR a 500-status domain
 * error (e.g. AccessMutationService wraps unexpected raw errors in a 500
 * AccessMutationError, message included) — is an INTERNAL error: logged
 * server-side in full, answered with a generic message. A raw `err.message`
 * must never leak through a 500 (it can carry fs/db paths and internals the
 * caller has no business seeing).
 */

import type express from 'express';
import { WorkflowDomainError } from '../workflow/workflow.errors.js';

/** One error shape for every access-family route. */
export function toHttpError(
  err: unknown,
  logTag: string,
): { status: number; body: Record<string, unknown> } {
  if (err instanceof WorkflowDomainError && err.status < 500) {
    // Spread the payload FIRST and assign `error` LAST — a payload key named
    // `error` must never overwrite the message the client renders.
    return { status: err.status, body: { ...(err.payload ?? {}), error: err.message } };
  }
  console.error(`[${logTag}] route failure:`, err instanceof Error ? err.stack ?? err.message : err);
  const status = err instanceof WorkflowDomainError ? err.status : 500;
  return { status, body: { error: 'Internal error.' } };
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
