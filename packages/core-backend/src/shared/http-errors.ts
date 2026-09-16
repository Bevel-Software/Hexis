import type { WorkflowDomainError } from './domain-errors.js';

/**
 * THE response body for a domain refusal: the error's own message, plus
 * whatever its payload carries, for a client that switches on the shape
 * rather than on the prose.
 *
 * The payload is an open `Record<string, unknown>` and deliberately stays
 * that way — `WorkflowValidationError` takes one from its caller — so this
 * lists no closed set. The discriminator to reach for is `kind`
 * (`path-traversal`, `unreadable-archive`, `no-shared-history`, …), which
 * most refusals carry; beside it they add whatever context that kind needs
 * (`branchName`, `head`/`base`, `conflictedPaths`, `feature`), and
 * `AccessConfigError` carries `accessConfigErrors` instead. Read the
 * subclass to know what its own refusal brings.
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
