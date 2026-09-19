/**
 * A move that CANNOT replace what is at its destination, whatever happens
 * between the look and the move.
 *
 * Looking first and then calling `fs.rename` is not enough on its own:
 * `rename` replaces an existing file on every platform, so two moves aiming at
 * the same free name can both be told it is free and the second one silently
 * eats what the first one landed. The window is small and the loss is total,
 * which is the worst pair. This module closes it with filesystem calls that
 * fail-by-design when the name is taken, so the refusal does not depend on
 * timing at all:
 *
 *   - A FILE moves as `link` + `unlink`. `link` is the atomic no-clobber
 *     primitive POSIX gives us: it fails with `EEXIST` if anything is at the
 *     new name, and the two names address one inode in between, so nothing is
 *     ever half-moved. On a filesystem that has no hard links at all we fall
 *     back to a plain `rename` (see `linkThenUnlink`) — no worse than before.
 *   - A FOLDER claims its name with `mkdir` first, which fails with `EEXIST`
 *     the same way, and then renames onto the empty folder it just made
 *     (POSIX lets a directory rename replace an EMPTY directory, and only an
 *     empty one). Windows will not do that, so there the plain `rename` is
 *     used — it refuses a taken destination for directories natively.
 *
 * The look still happens first, because it is what produces the sentence the
 * user reads: "A file named Notes.md already exists in Sales." names the kind
 * of thing in the way, which `EEXIST` alone does not tell us. The atomic call
 * is the backstop under it, and when the backstop is the one that fires the
 * destination is re-examined so the same sentence comes out.
 */
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { entryExistsMessage, type ExistingEntryKind } from '@bevel-software/platform-shared';
import { isAbsence } from './fs.contract.js';

/**
 * A move or copy refused because its destination is taken. Carries the kind
 * so the caller can raise it as whatever its surface answers with — the
 * workspace service's `EntryExistsError` (409 to the sidebar), a `ToolError`
 * (409 to the agent) — without re-deriving the sentence.
 */
export class DestinationTakenError extends Error {
  readonly status = 409;
  constructor(readonly entryKind: ExistingEntryKind, readonly destination: string) {
    super(entryExistsMessage(entryKind, destination));
    this.name = 'DestinationTakenError';
  }
}

/** What is at the destination, as far as a move from `oldPath` is concerned. */
export type DestinationVerdict =
  /** Nothing is there; the move may land. */
  | { state: 'free' }
  /**
   * The entry there IS the source: a case-insensitive filesystem opening
   * `Notes.md` and `notes.md` as one file. That is the rename that was asked
   * for, not a clash.
   */
  | { state: 'self' }
  /** Something else has the name. */
  | { state: 'taken'; kind: ExistingEntryKind };

/** The entry at `absolutePath` without following a link, or null when nothing is there. */
export async function lstatOrNull(absolutePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(absolutePath);
  } catch (err) {
    if (isAbsence(err)) return null;
    throw err;
  }
}

/**
 * The one reading of "is this destination the source under another name?".
 *
 * Identity alone (same device, same inode) is too broad: two hard links are
 * one inode under two unrelated names, and a move onto one of them would
 * destroy that name — a clash like any other. A case-only rename is the
 * narrower thing, and it is recognisable in the paths: the two spellings fold
 * together, which is exactly why the filesystem handed us one entry for both.
 * So both must hold — one inode AND one name up to case.
 *
 * `lstat`, never `stat`: a link at the destination is an entry in its own
 * right.
 */
export async function inspectDestination(
  oldAbsolute: string,
  newAbsolute: string,
): Promise<DestinationVerdict> {
  const destination = await lstatOrNull(newAbsolute);
  if (destination === null) return { state: 'free' };
  const source = await lstatOrNull(oldAbsolute);
  // A source that is not there is left to the move's own ENOENT — "there is
  // nothing to move" is the truer answer than "the name is taken".
  if (source === null) return { state: 'free' };
  if (
    source.dev === destination.dev &&
    source.ino === destination.ino &&
    foldsTogether(oldAbsolute, newAbsolute)
  ) {
    return { state: 'self' };
  }
  return { state: 'taken', kind: destination.isDirectory() ? 'folder' : 'file' };
}

/** The two paths are one name on a case-insensitive filesystem. */
function foldsTogether(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Move `oldAbsolute` to `newAbsolute`, refusing rather than replacing whatever
 * is already at the new name. `destinationLabel` is the path the refusal names
 * — workspace-relative, so the user reads the name they typed and the folder
 * they aimed at, not a path on our disk.
 *
 * The caller is expected to have made the destination's parent already; this
 * only performs the move itself, so a refusal cannot leave folders behind.
 */
export async function renameNoReplace(
  oldAbsolute: string,
  newAbsolute: string,
  destinationLabel: string,
): Promise<void> {
  const verdict = await inspectDestination(oldAbsolute, newAbsolute);
  if (verdict.state === 'taken') throw new DestinationTakenError(verdict.kind, destinationLabel);
  // A case-only rename has the source itself at the destination, so no
  // no-clobber call can be used — every one of them would see the name taken.
  // `rename` is right here: it replaces the source with the source.
  if (verdict.state === 'self') {
    await fs.rename(oldAbsolute, newAbsolute);
    return;
  }
  const source = await lstatOrNull(oldAbsolute);
  if (source?.isDirectory() === true) {
    await moveFolder(oldAbsolute, newAbsolute, destinationLabel);
    return;
  }
  await linkThenUnlink(oldAbsolute, newAbsolute, destinationLabel);
}

/**
 * `link` + `unlink`: the destination is created atomically or not at all, and
 * the source only goes away once it exists under both names.
 *
 * The fallback covers filesystems that cannot make a hard link at all (`EPERM`
 * on some network and FUSE mounts, `EXDEV` across a mount point inside the
 * workspace): there, a plain `rename` is what we did before this existed, and
 * the look above has already refused a taken name. Racing is possible on those
 * mounts alone rather than everywhere.
 */
async function linkThenUnlink(
  oldAbsolute: string,
  newAbsolute: string,
  destinationLabel: string,
): Promise<void> {
  try {
    await fs.link(oldAbsolute, newAbsolute);
  } catch (err) {
    if (codeOf(err) === 'EEXIST') throw await takenError(newAbsolute, destinationLabel);
    if (codeOf(err) === 'ENOENT') throw err; // No source: the caller's own ENOENT.
    await renameOrTaken(oldAbsolute, newAbsolute, destinationLabel);
    return;
  }
  await fs.unlink(oldAbsolute);
}

/**
 * `mkdir` claims the name — atomically, failing with `EEXIST` if anything at
 * all is there — and the rename then replaces the empty folder we own. Should
 * the rename fail anyway (someone wrote INTO our empty folder in between, and
 * `rename` answers `ENOTEMPTY`), the claim is given back so a failed move
 * leaves no folder behind.
 *
 * Windows cannot rename onto an existing directory even when it is empty, so
 * the claim would make every folder move fail. It does not need one: its
 * `rename` refuses a taken destination for directories by itself.
 */
async function moveFolder(
  oldAbsolute: string,
  newAbsolute: string,
  destinationLabel: string,
): Promise<void> {
  if (process.platform === 'win32') {
    await renameOrTaken(oldAbsolute, newAbsolute, destinationLabel);
    return;
  }
  try {
    await fs.mkdir(newAbsolute);
  } catch (err) {
    if (codeOf(err) === 'EEXIST') throw await takenError(newAbsolute, destinationLabel);
    throw err;
  }
  try {
    await fs.rename(oldAbsolute, newAbsolute);
  } catch (err) {
    await fs.rmdir(newAbsolute).catch(() => undefined);
    if (codeOf(err) === 'ENOTEMPTY' || codeOf(err) === 'EEXIST') {
      throw await takenError(newAbsolute, destinationLabel);
    }
    throw err;
  }
}

/**
 * The plain rename, with the one reading the caller needs of its failures: on
 * any error, whatever is at the destination now decides. Something there means
 * the name was taken after all (Windows answers `EPERM`, `EEXIST` or
 * `EACCES` for that case, depending on the kind); nothing there means the
 * failure was something else entirely and belongs to the caller.
 */
async function renameOrTaken(
  oldAbsolute: string,
  newAbsolute: string,
  destinationLabel: string,
): Promise<void> {
  try {
    await fs.rename(oldAbsolute, newAbsolute);
  } catch (err) {
    const occupant = await lstatOrNull(newAbsolute);
    if (occupant !== null) throw new DestinationTakenError(kindOf(occupant), destinationLabel);
    throw err;
  }
}

/** The refusal, with the kind read off whatever is actually in the way. */
export async function takenError(newAbsolute: string, destinationLabel: string): Promise<Error> {
  const occupant = await lstatOrNull(newAbsolute);
  return new DestinationTakenError(occupant === null ? 'file' : kindOf(occupant), destinationLabel);
}

function kindOf(entry: Stats): ExistingEntryKind {
  return entry.isDirectory() ? 'folder' : 'file';
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}
