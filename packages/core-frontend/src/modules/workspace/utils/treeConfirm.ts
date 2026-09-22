import {
  isPlatformFile,
  isPlatformRestoreShape,
  isRootPlatformFile,
  platformFileRefusal,
  type FileTreeEntry,
} from '@bevel-software/platform-shared';
import {
  parsePluginPrincipalToken,
  pluginPrincipalLabel,
  type AccessPrincipalRef,
  type PathPrincipals,
  type ProspectiveAccess,
} from '../../access/api';
import { KB_ROOT_DIRS } from './fileTree';

// What the tree's delete and move confirmations say — see
// `components/TreeActionConfirm.tsx` for the dialog that says it.

/** The repo-relative form of a workspace-relative path, or null outside the KB clone. */
function repoRelative(wsRelativePath: string, kbDirName: string | null): string | null {
  if (!kbDirName) return null;
  const prefix = `${kbDirName}/`;
  return wsRelativePath.startsWith(prefix) ? wsRelativePath.slice(prefix.length) : null;
}

/**
 * Why this row may not be renamed, moved or dragged — the same sentence the
 * server refuses with — or null when it may.
 *
 * Judged on the path's REPO-relative form, because that is what the platform
 * reads: `roles.yaml` and the agent guide (`AGENTS.md` unless this deployment
 * named it something else) count at the repository root only, so a nested file
 * of either name is ordinary content and stays draggable. Outside
 * the KB clone, and before `kbDirName` is known, nothing is refused here — the
 * server is the gate and says the same sentence.
 */
export function platformFileMoveRefusal(
  wsRelativePath: string,
  kbDirName: string | null,
): string | null {
  const rel = repoRelative(wsRelativePath, kbDirName);
  if (rel === null) return null;
  return isPlatformFile(rel) ? platformFileRefusal(rel) : null;
}

/**
 * Why this row may not be DRAGGED, or null when it may — the rename refusal
 * minus the one move that is a repair.
 *
 * An admin may put a misplaced platform file back where the platform reads it
 * (a stray `access.md` into a folder that has none, a stray `.bevelignore`
 * onto the root), and dragging it there is how a person does that. Refusing
 * the drag on the row would leave that recovery reachable only over the API —
 * for `access.md`, which is a platform file wherever it sits, not reachable
 * from the sidebar at all — while the sentence shown promised what the server
 * would say and the server would have said yes.
 *
 * So the row's own copy of the rule keeps only the part that is certain: the
 * ROOT's copy never moves, and nobody but an admin moves any of them. What is
 * left — which destination, and whether the disk agrees — the drop's own
 * response says, because only the server knows it. A rename is never a
 * repair (it lands the file beside the name the platform reads, not on it),
 * so it keeps the full refusal.
 */
export function platformFileDragRefusal(
  wsRelativePath: string,
  kbDirName: string | null,
  isAdmin: boolean,
): string | null {
  const refusal = platformFileMoveRefusal(wsRelativePath, kbDirName);
  if (refusal === null || !isAdmin) return refusal;
  const rel = repoRelative(wsRelativePath, kbDirName);
  return rel === null || isRootPlatformFile(rel) ? refusal : null;
}

/**
 * Every file under a folder, at any depth — what a folder delete takes with it.
 * `isProposed` names the rows that are only proposed (a change request's file
 * this branch does not have): they are not on the branch, so the delete does
 * not take them, and they are not counted.
 */
export function countFiles(entry: FileTreeEntry, isProposed: (path: string) => boolean = () => false): number {
  if (entry.type === 'file') return isProposed(entry.relativePath) ? 0 : 1;
  return (entry.children ?? []).reduce((n, child) => n + countFiles(child, isProposed), 0);
}

/**
 * The reserved root a workspace-relative path sits in (`KnowledgeBase`,
 * `Skills`, `Data`, …), or null when it sits in none — outside the KB clone,
 * at its top level, or in a stray top-level folder.
 */
export function rootOf(path: string, kbDirName: string | null): string | null {
  if (!kbDirName || !path.startsWith(`${kbDirName}/`)) return null;
  const first = path.slice(kbDirName.length + 1).split('/')[0];
  return first && KB_ROOT_DIRS.has(first) ? first : null;
}

const possessive = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

export function deleteSentence(entry: FileTreeEntry, isProposed?: (path: string) => boolean): string {
  if (entry.type === 'file') return `Delete ${entry.name}?`;
  const n = countFiles(entry, isProposed);
  return `Delete ${entry.name} and its ${n} ${n === 1 ? 'file' : 'files'}?`;
}

/** `#12 "Title" by Ana (2 files)` — one open change request as a folder delete names it. */
export function folderRequestLine(request: {
  number: number;
  title: string;
  authorName: string | null;
  mine: boolean;
  paths: string[];
}): string {
  const by = request.mine ? 'by you' : request.authorName ? `by ${request.authorName}` : null;
  const n = request.paths.length;
  return `#${request.number} “${request.title}”${by ? ` ${by}` : ''} (${n} proposed ${n === 1 ? 'file' : 'files'})`;
}

/**
 * The move question on its own. The dialog follows it with what the access
 * lookup found: the lose and gain blocks, "Nobody's access changes.", or —
 * when the lookup could not answer — {@link moveSentence}'s older sentence
 * and a note saying so.
 */
export function moveQuestion(name: string, destination: string): string {
  return `Move ${name} to ${destination}?`;
}

/**
 * The move question with the one sentence it used to carry alone. Still what
 * the dialog says when the access change is not known: a tester read this as
 * unclear, which is why the blocks exist, but it is honest where a list of
 * names would be a guess.
 */
export function moveSentence(name: string, destination: string): string {
  return `${moveQuestion(name, destination)} Access to it will follow ${possessive(destination)} rules from now on.`;
}

/** What the dialog reads when the lookup answered and found no change. */
export const NO_ACCESS_CHANGE = "Nobody's access changes.";

/** What the dialog reads when the lookup failed or ran out of its two seconds. */
export const ACCESS_CHANGE_UNKNOWN = "Couldn't work out the access change.";

/**
 * The whole budget for the access lookup. Past it the dialog stops claiming to
 * know: a confirmation the user is staring at may not wait on a resolver.
 */
export const ACCESS_LOOKUP_TIMEOUT_MS = 2000;

/** Lines past this many are folded into "and N more". */
const ACCESS_BLOCK_CAP = 6;

/** The two verbs the move compares, in the order their lines are listed. */
const ACCESS_VERBS = ['read', 'write'] as const;

/** How each verb reads to someone who is not thinking about access grammar. */
const VERB_WORD: Record<(typeof ACCESS_VERBS)[number], string> = {
  read: 'open',
  write: 'edit',
};

/**
 * A principal as the Manage access dialog names it — the same spelling in both
 * places, so the confirmation and the sheet never describe one grant two ways.
 * A plugin principal's raw `plugin/<Name>/<verb>` token becomes "GTM ·
 * readers"; the built-in `everyone` role becomes "Everyone".
 */
export function principalLabel(principal: AccessPrincipalRef): string {
  if (principal.kind === 'plugin') {
    const parsed = parsePluginPrincipalToken(principal.name);
    return parsed ? pluginPrincipalLabel(parsed.plugin, parsed.verb) : principal.name;
  }
  if (principal.kind === 'role' && principal.name.trim().toLowerCase() === 'everyone') {
    return 'Everyone';
  }
  // A person granted directly, with no display name on record, is still
  // someone: their email names them better than a blank line does.
  if (principal.kind === 'person') return principal.name || (principal.email ?? '');
  return principal.name;
}

/**
 * One principal's identity across the two sides of the move. People are the
 * same person at the same address whatever name each side carries; a
 * collective is the same principal at the same name and kind — a group and a
 * role sharing a name are two principals, as everywhere else in access.
 */
function principalKey(principal: AccessPrincipalRef): string {
  return principal.kind === 'person'
    ? `person:${(principal.email ?? principal.name).toLowerCase()}`
    : `${principal.kind}:${principal.name.toLowerCase()}`;
}

/** The lose and gain blocks of one move, each already capped. */
export interface AccessChange {
  lose: string[];
  gain: string[];
}

/** Six lines, then "and N more" for the rest. */
function capped(lines: string[]): string[] {
  if (lines.length <= ACCESS_BLOCK_CAP) return lines;
  return [...lines.slice(0, ACCESS_BLOCK_CAP), `and ${lines.length - ACCESS_BLOCK_CAP} more`];
}

/**
 * Who loses and who gains access in one move: per verb, the principals
 * present before and absent after, and absent before and present after.
 *
 * Lines are grouped by principal in the order the lists name them — the
 * resolver's order, collectives before directly granted people — and within a
 * principal, opening before editing. A principal that loses one verb and
 * gains another appears in both blocks, which is what happened.
 */
export function accessChangeLines(before: PathPrincipals, after: PathPrincipals): AccessChange {
  const lose: string[] = [];
  const gain: string[] = [];
  // First-seen order over every list, so a principal's lines sit together
  // wherever the verb that introduced it came from.
  const order: AccessPrincipalRef[] = [];
  const seen = new Set<string>();
  for (const side of [before, after]) {
    for (const verb of ACCESS_VERBS) {
      for (const principal of side[verb]) {
        const key = principalKey(principal);
        if (seen.has(key)) continue;
        seen.add(key);
        order.push(principal);
      }
    }
  }
  const keysOf = (list: AccessPrincipalRef[]) => new Set(list.map(principalKey));
  const sides = {
    before: { read: keysOf(before.read), write: keysOf(before.write) },
    after: { read: keysOf(after.read), write: keysOf(after.write) },
  };
  for (const principal of order) {
    const key = principalKey(principal);
    const label = principalLabel(principal);
    for (const verb of ACCESS_VERBS) {
      const had = sides.before[verb].has(key);
      const has = sides.after[verb].has(key);
      if (had && !has) lose.push(`${label}: can no longer ${VERB_WORD[verb]}`);
      if (!had && has) gain.push(`${label}: can ${VERB_WORD[verb]}`);
    }
  }
  return { lose: capped(lose), gain: capped(gain) };
}

/** {@link accessChangeLines} over a whole prospective-access answer. */
export function accessChangeOf(access: ProspectiveAccess): AccessChange {
  return accessChangeLines(access.before, access.after);
}

/**
 * The warnings that apply to one move, in a fixed order.
 *
 * `canWrite` is the caller's write permission on the destination: `false`
 * adds the refusal warning, `null` (not known yet, or the lookup failed) adds
 * nothing — the dialog never blocks on it, and the server stays the gate.
 * A move into a folder the caller may not write is REFUSED today: the move
 * route acquires the write lock on both ends, and the lock gate throws
 * AccessDeniedError on a protected branch (`WorkflowService.acquireLock`).
 * Only uploads are rerouted to a suggestion; a move is not.
 */
export function moveWarnings(opts: {
  sourcePath: string;
  targetDir: string;
  destinationLabel: string;
  kbDirName: string | null;
  canWrite: boolean | null;
  /**
   * Whether the person making the move is an admin. Only the restore line
   * reads it, and it must: a nested `roles.yaml` is ordinary content, so
   * ANYONE can drag one at the root, and telling a non-admin their move is
   * "allowed for an Admin" would promise them what the server will refuse.
   */
  isAdmin?: boolean;
}): string[] {
  const name = opts.sourcePath.split('/').pop() ?? opts.sourcePath;
  const warnings: string[] = [];
  if (opts.canWrite === false) {
    // A restore is the one move allowed past a destination that refuses the
    // write, so for the admin who may make it "the move will be refused" is
    // the wrong prediction. For everyone else it is the right one.
    const destination = opts.targetDir ? `${opts.targetDir}/${name}` : name;
    const from = repoRelative(opts.sourcePath, opts.kbDirName);
    const to = repoRelative(destination, opts.kbDirName);
    const restore =
      opts.isAdmin === true && from !== null && to !== null && isPlatformRestoreShape(from, to);
    warnings.push(
      restore
        ? `You can't write to ${opts.destinationLabel}, but putting ${name} back where the platform reads it is allowed for an Admin.`
        : `You can't write to ${opts.destinationLabel} — the move will be refused.`,
    );
  }
  // No platform-file warning here: moving one out of its folder breaks the
  // workspace, so the tree refuses it outright (`platformFileMoveRefusal`)
  // instead of offering it as something to confirm. The only platform file
  // that still reaches this dialog is a misplaced one an admin is putting
  // back, and there is nothing to warn about in a repair.
  const fromRoot = rootOf(opts.sourcePath, opts.kbDirName);
  const toRoot = rootOf(opts.targetDir ? `${opts.targetDir}/${name}` : name, opts.kbDirName);
  if (fromRoot && toRoot && fromRoot !== toRoot) {
    warnings.push(`This moves it out of ${fromRoot}/ into ${toRoot}/ — the two roots are handled differently.`);
  }
  return warnings;
}

/**
 * What a withdraw asks before it takes a suggestion back.
 *
 * Withdrawal is per REQUEST, never per file: a multi-file drop became ONE
 * change request, and cancelling it cancels all of it. The user right-clicked
 * a single row, so the count is said out loud — learning afterwards that two
 * other files went with it is the one outcome this sentence exists to prevent.
 */
export function withdrawSentence(files: string[]): string {
  if (files.length > 1) return `This withdraws the whole suggestion: ${files.length} files`;
  const name = files[0]?.split('/').pop();
  return name ? `Withdraw ${name}?` : 'Withdraw this suggestion?';
}
