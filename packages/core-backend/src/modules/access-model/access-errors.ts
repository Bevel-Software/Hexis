import { WorkflowDomainError } from '../../shared/domain-errors.js';

export interface AccessDeniedDetails {
  /** repo-relative POSIX path the caller tried to write */
  path: string;
  /** Display names of roles that would grant write at this path. */
  eligibleRoles: string[];
  /** Direct user grants at this path, in `{name, email}` form. */
  eligibleUsers: { name: string; email: string }[];
}

/**
 * Thrown when a user lacks the `write` permission on a path under the
 * access-control rules in `roles.yaml` + `access.md`.
 *
 * Carries enough detail in the JSON payload for the frontend to render
 * "you don't have permission to write to <path>; eligible: <roles + users>"
 * without a follow-up roundtrip.
 */
export class AccessDeniedError extends WorkflowDomainError {
  readonly access: AccessDeniedDetails;

  constructor(details: AccessDeniedDetails) {
    const rolesPart = details.eligibleRoles.length
      ? details.eligibleRoles.join(', ')
      : 'none';
    const usersPart = details.eligibleUsers.length
      ? details.eligibleUsers
          .map((u) => (u.name ? `${u.name} <${u.email}>` : u.email))
          .join(', ')
      : '';
    const eligible = [rolesPart, usersPart].filter(Boolean).join('; ');
    super(
      `You don't have permission to write to "${details.path}". Eligible: ${eligible}.`,
      403,
      { access: details },
    );
    this.name = 'AccessDeniedError';
    this.access = details;
  }
}

/**
 * Thrown when the access tree at a git ref could not be READ (a git
 * subprocess failed on the way), as opposed to being absent or malformed.
 * Nothing was decided: a verdict from a partially read tree could grant what
 * a lost `access.md` would have denied, so the operation fails closed with a
 * 503 and the caller retries. Distinct from AccessConfigError (the config is
 * there and wrong) and AccessDeniedError (a real permission decision).
 */
export class AccessUnreadableError extends WorkflowDomainError {
  constructor(ref: string, relativePath: string) {
    super(
      `Access rules at ${ref} could not be read (git failed on ${relativePath}); nothing was decided. Try again.`,
      503,
      { ref, path: relativePath },
    );
    this.name = 'AccessUnreadableError';
  }
}

/**
 * Thrown when the access-control config (roles.yaml or access.md) is missing
 * or malformed at runtime — distinct from AccessDeniedError because the cause
 * is a config bug, not a permission decision.
 */
export class AccessConfigError extends WorkflowDomainError {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(
      `Access-control config is invalid: ${errors.join('; ')}`,
      500,
      { accessConfigErrors: errors },
    );
    this.name = 'AccessConfigError';
    this.errors = errors;
  }
}
