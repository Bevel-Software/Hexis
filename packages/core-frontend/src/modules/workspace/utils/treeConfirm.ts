import { isPlatformFile, platformFileRefusal, type FileTreeEntry } from '@bevel-software/platform-shared';
import { KB_ROOT_DIRS } from './fileTree';

// What the tree's delete and move confirmations say — see
// `components/TreeActionConfirm.tsx` for the dialog that says it.

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
  if (!kbDirName) return null;
  const prefix = `${kbDirName}/`;
  if (!wsRelativePath.startsWith(prefix)) return null;
  const repoRelative = wsRelativePath.slice(prefix.length);
  return isPlatformFile(repoRelative) ? platformFileRefusal(repoRelative) : null;
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
    warnings.push(`You can't write to ${opts.destinationLabel} — the move will be refused.`);
  }
  // No platform-file warning here: a platform file no longer reaches this
  // dialog at all. Moving one out of its folder breaks the workspace, so the
  // tree refuses it outright (`platformFileMoveRefusal`) instead of offering
  // it as something to confirm.
  const from = rootOf(opts.sourcePath, opts.kbDirName);
  const to = rootOf(opts.targetDir ? `${opts.targetDir}/${name}` : name, opts.kbDirName);
  if (from && to && from !== to) {
    warnings.push(`This moves it out of ${from}/ into ${to}/ — the two roots are handled differently.`);
  }
  return warnings;
}
