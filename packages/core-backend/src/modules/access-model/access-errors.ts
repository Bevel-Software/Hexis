import { WorkflowDomainError } from '../../shared/domain-errors.js';

export interface AccessDeniedDetails {
  /** repo-relative POSIX path the caller tried to write */
  path: string;
  /** Display names of roles that would grant write at this path. */
  eligibleRoles: string[];
  /** Direct user grants at this path, in `{name, email}` form. */
  eligibleUsers: { name: string; email: string }[];
  /**
   * The eligible roles and groups WITH their kind, when known. `eligibleRoles`
   * erases kind, so a role and a group sharing a display name are one entry
   * there — too little to tell which of the two the caller holds.
   */
  eligiblePrincipals?: DeniedPrincipal[];
  /**
   * The roles and groups the CALLER holds, when known. A listed principal the
   * caller already holds cannot be the way in — they hold it and were still
   * refused, so something nearer excludes it — and naming it as "eligible"
   * reads as a contradiction. The message then says that principal is
   * excluded here instead of listing who is eligible. Matched against
   * `eligiblePrincipals` by kind AND name: holding the group `Ops` says
   * nothing about the role `Ops`.
   */
  callerPrincipals?: DeniedPrincipal[];
}

/** A role or group named in a denial. */
export interface DeniedPrincipal {
  name: string;
  kind: string;
}

const principalIdentity = (p: DeniedPrincipal): string => `${p.kind}\0${p.name.toLowerCase()}`;

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
    const held = new Set((details.callerPrincipals ?? []).map(principalIdentity));
    const excluded = (details.eligiblePrincipals ?? []).filter((p) => held.has(principalIdentity(p)));
    if (excluded.length) {
      const names = excluded.map((p) => `the ${p.name} ${p.kind}`).join(', ');
      super(
        `You don't have permission to write to "${details.path}". ${names.charAt(0).toUpperCase()}${names.slice(1)} ${excluded.length === 1 ? 'is' : 'are'} excluded at this folder.`,
        403,
        { access: details },
      );
      this.name = 'AccessDeniedError';
      this.access = details;
      return;
    }
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
