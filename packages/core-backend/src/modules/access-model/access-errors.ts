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
   * write grant: the repo-relative path the caller cannot read, which is the
   * path being changed whether or not something is at it (`''` for the
   * repository root). Nothing can be created, changed or removed at a place
   * the caller cannot see, whatever write rules say, so the eligible lists
   * are empty and the message names the unreadable path instead.
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

/**
 * The same writers for a RECORD (a log line, the pending-commit queue, the
 * recovery agent's prompt, an operator's notice): the roles, and how many
 * people are named beside them, never who. Log lines carry no names or
 * email addresses; the count still tells an operator that the roles are not
 * the whole list.
 */
function eligibleWritersForRecord(roles: string[], users: { name: string; email: string }[]): string {
  const people = users.length ? `${users.length} named ${users.length === 1 ? 'person' : 'people'}` : '';
  if (roles.length === 0) return people || 'none';
  return people ? `${roles.join(', ')} and ${people}` : roles.join(', ');
}

/** The file a push-gate refusal names, and who may write it at the published state. */
export interface PushAccessRefusal {
  /** Repo-relative POSIX path of the file the unpushed commit changed. */
  path: string;
  eligibleRoles: string[];
  eligibleUsers: { name: string; email: string }[];
}

/**
 * The sentence a push-gate refusal is told in: the platform refused (never
 * the repository host) and, given the refusal, which file and who may write
 * it. Given null, the file goes unnamed, for a person who may not read it.
 * One composition for the person who pushed, the sync banner each viewer
 * sees and (as `record`) the operator's records, so they never say it
 * differently.
 */
export function pushAccessRefusalSentence(
  branch: string,
  refusal: PushAccessRefusal | null,
  audience: 'person' | 'record' = 'person',
): string {
  return `The platform's access check refused the push of "${branch}": ${pushAccessRefusalClause(refusal, audience)}.`;
}

/**
 * The clause after "refused the push:". `person`: for someone reading it in
 * the app, with the people who may write the file named. `record`: for a log
 * line, the queue or a prompt, with the roles and a count of the people.
 * Given null, neither names a file or a writer; only the person's says "a
 * file you may not read", since a record's reader is not known.
 */
function pushAccessRefusalClause(refusal: PushAccessRefusal | null, audience: 'person' | 'record'): string {
  if (!refusal) {
    const remedy = 'someone who may write that file can share the branch';
    return audience === 'person'
      ? `an unshared commit on it changes a file you may not read, which neither its author nor the person sharing may write there; ${remedy}`
      : `an unshared commit on it changes a file that neither its author nor the person sharing may write there; ${remedy}`;
  }
  const writers =
    audience === 'person'
      ? eligibleWritersPhrase(refusal.eligibleRoles, refusal.eligibleUsers)
      : eligibleWritersForRecord(refusal.eligibleRoles, refusal.eligibleUsers);
  return `"${sanitizedPath(refusal.path)}" may be written by ${writers}`;
}

/**
 * The platform's own access check refused to push a protected branch: an
 * unpushed commit changes a file that neither the commit's author nor the
 * pusher may write at the branch's published state. The push never left this
 * server, so this is NOT the repository host refusing, and nothing that
 * relays it may say so.
 *
 * `blocked` is the file and who may write it, always. What the PUSHER is
 * told is `refusal`: the same, or null when they may not read the file — a
 * commit by somebody else can touch a file they cannot see, and naming it,
 * or who may write it, would disclose what the read model hides from them.
 * The message, `reason` and `payload` are scoped to the pusher the same way.
 * `blocked` is for a relay that judges each of its own readers, as the sync
 * banner's delivery does per session.
 *
 * `reason` is the clause after "refused the push:", composed here from
 * repository paths and principals only (never git output), so the
 * saved-locally sentence can carry it verbatim to the person who saved.
 * `recordReason` and `recordMessage` are the same clause and sentence for a
 * record that only whoever runs the deployment reads (the server log, an
 * operator's notice). It always names the file and the roles that may write
 * it, whatever the pusher may read: an operator told only that "a file"
 * blocks the branch has nothing to act on. The people who may write the
 * file are counted there, never named.
 *
 * `sharedReason` is the clause for text that is kept and later shown to
 * people this error cannot judge: the pending-commit queue's last error
 * reaches whoever next merges or updates the branch. It names no file and
 * no writer.
 */
export class PushAccessRefusedError extends VersionControlDomainError {
  readonly kind = 'push-access-refused' as const;
  readonly reason: string;
  readonly recordReason: string;
  readonly recordMessage: string;
  readonly sharedReason: string;
  /** What the pusher may be told: `blocked`, or null when they may not read its file. */
  readonly refusal: PushAccessRefusal | null;

  constructor(
    readonly branch: string,
    readonly blocked: PushAccessRefusal,
    pusherMayRead: boolean,
  ) {
    const refusal = pusherMayRead ? blocked : null;
    super(
      pushAccessRefusalSentence(branch, refusal),
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
    this.refusal = refusal;
    this.reason = pushAccessRefusalClause(refusal, 'person');
    this.recordReason = pushAccessRefusalClause(blocked, 'record');
    this.recordMessage = pushAccessRefusalSentence(branch, blocked, 'record');
    this.sharedReason = pushAccessRefusalClause(null, 'record');
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
