import type { WorkflowDomainError } from './domain-errors.js';

/**
 * THE response body for a domain refusal: the error's own message, plus
 * whatever typed discriminators its payload carries — `kind`
 * (`path-traversal`, `unreadable-archive`, …) and `accessConfigErrors` are
 * the ones {@link WorkflowDomainError} subclasses set today — for a client
 * that switches on them rather than on the prose.
 *
 * Eight route surfaces built this object by hand, and seven of them spread
 * the payload AFTER the message:
 *
 *   { error: err.message, ...err.payload }   // payload wins
 *
 * A payload is a `Record<string, unknown>`, so a key named `error` is
 * expressible — and in that shape it silently replaces the one line the
 * client renders, leaving a refusal that says something else entirely. The
 * eighth site had it right and said so in a comment; this is that comment
 * made into the only way to build the body.
 *
 * The STATUS is deliberately not decided here. Each surface keeps its own
 * 5xx policy — the admin roster routes never leak a 5xx detail, while the
 * workspace routes surface `AccessConfigError`'s message because an admin
 * has to read it — and those differ on purpose, not by drift.
 */
export function domainErrorBody(err: WorkflowDomainError): Record<string, unknown> {
  // Payload FIRST, `error` LAST: the message always wins.
  return { ...(err.payload ?? {}), error: err.message };
}
