import { VersionControlDomainError } from '../../shared/domain-errors.js';
import { sanitizedPath } from '../../shared/printable.js';

export interface AccessDeniedDetails {
  /** repo-relative POSIX path the caller tried to write */
  path: string;
  /** Display names of roles that would grant write at this path. */
  eligibleRoles: string[];
  /** Direct user grants at this path, in `{name, email}` form. */
  eligibleUsers: { name: string; email: string }[];
  /**
   * Set when the refusal is the READ-BEFORE-WRITE rule rather than a missing
   * write grant: the repo-relative path the caller cannot read — the file
   * itself, or the folder a new file would land in (`''` for the repository
   * root). Nothing can be created, changed or removed at a place the caller
   * cannot see, whatever write rules say, so the eligible lists are empty
   * and the message names the unreadable place instead.
   */
  unreadable?: string;
  /**
   * What `path` is, when the refuser knows: a folder a move or delete was
   * judged on, or a file. Read by the tools' `write-denied` mapping to ask
   * the read gate the right question about proposing the change on a draft —
   * a folder directly under a root is proposable where a file there is not.
   * Absent means file.
   */
  targetKind?: 'file' | 'dir';
}

/**
 * How the read-before-write refusal names the unreadable place. The path is
 * the caller's own text and goes into a one-line sentence, so a line break
 * in it is shown, not obeyed.
 */
export function unreadablePlaceLabel(repoRelative: string): string {
  return repoRelative === '' ? 'the top level' : `"${sanitizedPath(repoRelative)}"`;
}

/**
 * The sentence a read-before-write refusal ends with. One spelling, shared
 * with the write-denial mapping and the frontend's friendly rewrite, so the
 * three never drift.
 */
export function unreadableRefusalSentence(repoRelative: string): string {
  return `You don't have read access to ${unreadablePlaceLabel(repoRelative)}; only what you can read can be created, changed or removed.`;
}

/**
 * Thrown when a user lacks the `write` permission on a path under the
 * access-control rules in `roles.yaml` + `access.md` — or, with `unreadable`
 * set, when they may not READ where the write would land (see
 * `AccessDeniedDetails.unreadable`).
 *
 * Carries enough detail in the JSON payload for the frontend to render
 * "you don't have permission to write to <path>; eligible: <roles + users>"
 * without a follow-up roundtrip.
 */
export class AccessDeniedError extends VersionControlDomainError {
  readonly access: AccessDeniedDetails;

  constructor(details: AccessDeniedDetails) {
    const lead = `You don't have permission to write to "${details.path}".`;
    let tail: string;
    if (details.unreadable !== undefined) {
      tail = unreadableRefusalSentence(details.unreadable);
    } else {
      tail = `Eligible: ${eligibleWritersPhrase(details.eligibleRoles, details.eligibleUsers)}.`;
    }
    super(`${lead} ${tail}`, 403, { access: details });
    this.name = 'AccessDeniedError';
    this.access = details;
  }
}

/**
 * How a refusal names who may write a path: the roles (`none` when there are
 * none), then the people. One spelling for the save-time refusal and the
 * push gate's, so the two never name the same writers differently.
 */
function eligibleWritersPhrase(roles: string[], users: { name: string; email: string }[]): string {
  const rolesPart = roles.length ? roles.join(', ') : 'none';
  const usersPart = users.length ? users.map((u) => (u.name ? `${u.name} <${u.email}>` : u.email)).join(', ') : '';
  return [rolesPart, usersPart].filter(Boolean).join('; ');
}

/** The file a push-gate refusal names, and who may write it at the published state. */
export interface PushAccessRefusal {
  /** Repo-relative POSIX path of the file the unpushed commit changed. */
  path: string;
  eligibleRoles: string[];
  eligibleUsers: { name: string; email: string }[];
}

/**
 * The platform's own access check refused to push a protected branch: an
 * unpushed commit changes a file that the commit's author (or the pusher,
 * for an author the platform cannot match to a user) may not write at the
 * branch's published state. The push never left this server, so this is NOT
 * the repository host refusing, and nothing that relays it may say so.
 *
 * `refusal` is null when the person pushing may not read the file: a commit
 * by somebody else can touch a file they cannot see, and a refusal that
 * named it, or who may write it, would disclose what the read model hides
 * from them. The sentence then says a file they cannot read blocks the
 * branch, without naming it.
 *
 * `reason` is the clause after "refused the push:", composed here from
 * repository paths and principals only (never git output), so the sync
 * banner, the saved-locally sentence and the pending-commit queue can all
 * carry it verbatim.
 */
export class PushAccessRefusedError extends VersionControlDomainError {
  readonly kind = 'push-access-refused' as const;
  readonly reason: string;

  constructor(
    readonly branch: string,
    readonly refusal: PushAccessRefusal | null,
  ) {
    const reason = refusal
      ? `"${sanitizedPath(refusal.path)}" may be written by ${eligibleWritersPhrase(refusal.eligibleRoles, refusal.eligibleUsers)}`
      : 'an unshared commit on it changes a file you may not read, which its author may not write there; someone who may write that file can share the branch';
    super(
      `The platform's access check refused the push of "${branch}": ${reason}.`,
      403,
      refusal
        ? {
            kind: 'push-access-refused',
            branch,
            path: refusal.path,
            eligibleRoles: refusal.eligibleRoles,
            eligibleUsers: refusal.eligibleUsers,
          }
        : { kind: 'push-access-refused', branch },
    );
    this.name = 'PushAccessRefusedError';
    this.reason = reason;
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
export class AccessUnreadableError extends VersionControlDomainError {
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
export class AccessConfigError extends VersionControlDomainError {
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
