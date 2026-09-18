import {
  isPlatformFile,
  isPlatformRestoreShape,
  isRootPlatformFile,
  platformFileRefusal,
  type FileTreeEntry,
} from '@bevel-software/platform-shared';
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
 * reads: `roles.yaml` and `AGENTS.md` count at the repository root only, so a
 * nested file of either name is ordinary content and stays draggable. Outside
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

export function moveSentence(name: string, destination: string): string {
  return `Move ${name} to ${destination}? Access to it will follow ${possessive(destination)} rules from now on.`;
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
}): string[] {
  const name = opts.sourcePath.split('/').pop() ?? opts.sourcePath;
  const warnings: string[] = [];
  if (opts.canWrite === false) {
    // A restore is the one move allowed past a destination that refuses the
    // write, so saying it will be refused would be a wrong prediction — and
    // this dialog only ever sees a platform file when the row let the drag
    // start, which is an admin dragging a misplaced copy back.
    const destination = opts.targetDir ? `${opts.targetDir}/${name}` : name;
    const from = repoRelative(opts.sourcePath, opts.kbDirName);
    const to = repoRelative(destination, opts.kbDirName);
    const restore = from !== null && to !== null && isPlatformRestoreShape(from, to);
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
