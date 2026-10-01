import type { AuthUser, ChangeRequest } from '@bevel-software/platform-shared';
import type { Verb } from '../access-model/access-grammar.js';
import { accessMdPathForFolder, type TargetKind } from './access-mutation.service.js';

/**
 * The ITEM a request is about — a folder, or a file that carries its own
 * rules. Everything downstream (the branch name, the file spliced, the
 * permission checked) is derived from this pair, so a request on a file can
 * never reach beyond that file.
 */
export interface AccessRequestTarget {
  /** Repo-relative path of the item itself — NOT of its rules file. */
  path: string;
  kind: TargetKind;
}

/** A folder target, spelled once. */
export function folderTarget(repoRelFolder: string): AccessRequestTarget {
  return { path: repoRelFolder, kind: 'folder' };
}

/**
 * The file whose rules a request on this item edits: a folder's `access.md`,
 * or the file itself (its own frontmatter). The one place the two cases part,
 * so a file request writes nothing a sibling can see.
 */
export function rulesFileFor(target: AccessRequestTarget): string {
  return target.kind === 'folder' ? accessMdPathForFolder(target.path) : target.path;
}

/** The levels the Manage access dialog can ask for. `owner` covers `write`. */
export type RequestLevel = Extract<Verb, 'write' | 'owner'>;
export const REQUEST_LEVELS: readonly RequestLevel[] = ['write', 'owner'];
export function isRequestLevel(value: unknown): value is RequestLevel {
  return typeof value === 'string' && (REQUEST_LEVELS as readonly string[]).includes(value);
}

/** The optional note a requester may attach, in characters. */
export const REQUEST_NOTE_MAX = 500;

/**
 * One grant a request's branch still proposes. Structurally the plugin
 * module's `JoinProposal` — stated here so the access module can consume the
 * request lifecycle without importing the module that implements it (the
 * dependency runs library → access, and this keeps it that way).
 */
export interface AccessProposal {
  verb: Verb;
  id: string;
  principal:
    | { kind: 'user'; email: string; displayName: string }
    | { kind: 'role'; role: string };
  label: string;
}

/** One open request, as the editors' surfaces render it. */
export interface AccessRequestSummary {
  number: number;
  branch: string;
  requesterName: string;
  createdAt: string;
  proposals: AccessProposal[];
  /** The requester's note, as plain text, when they gave one. */
  note?: string;
}

/**
 * The request lifecycle, as the access module needs it: what a branch still
 * proposes, the open requests for an item, and the settle-if-nothing-is-left
 * check. Implemented by `JoinRequestsService`.
 *
 * `key` is what `joinBranchFor` was given when the branch was named — a
 * plugin's name for a Subscribe request, and the ITEM'S OWN PATH for every
 * request that comes from the Manage access dialog. Keying a skill folder's
 * request on its path is what makes the skill page's "Request write access"
 * and a Can edit request on that same folder one request rather than two.
 */
export interface IAccessRequestLifecycle {
  /** Null ⇒ the branch could not be read; that is not "proposes nothing". */
  proposalsOn(branch: string, target: AccessRequestTarget): Promise<AccessProposal[] | null>;
  list(
    key: string,
    target: AccessRequestTarget,
    crs: ChangeRequest[],
    actor: AuthUser,
  ): Promise<AccessRequestSummary[]>;
  reconcile(
    key: string,
    target: AccessRequestTarget,
    cr: ChangeRequest,
    actor: AuthUser,
  ): Promise<boolean>;
}
