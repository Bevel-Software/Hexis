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
 *     ever half-moved. A filesystem without hard links claims the name with
 *     `open(…, 'wx')` instead and renames onto its own claim — never a plain
 *     `rename`, which would put the overwrite back exactly where it is hardest
 *     to notice.
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
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
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

/** What the reading needs of an entry: which one it is, and whether it is a folder. */
export interface EntryIdentity {
  dev: number;
  ino: number;
  isDirectory(): boolean;
}

/**
 * The two filesystem facts a destination reading is made of: what is at a
 * path, and what a folder lists.
 *
 * It is a seam for ONE reason, stated plainly because it is the only thing
 * that justifies it: the reading's whole case-folding half — every answer of
 * `self`, which is what "a case-only rename is not a clash" means — can be
 * produced only by a case-insensitive volume, and there is none on the Linux
 * that CI and the container run. No `mount` and no `mkfs.vfat` in the
 * container either, so one cannot be made. Gated behind a `foldsCase()` probe,
 * those branches were executed by nothing on any machine that runs the suite,
 * while four review rounds reshaped them. A probe standing in for a folding
 * volume runs them everywhere.
 *
 * Deliberately narrow: the facts the reading consults, and nothing else. The
 * MOVE itself — `link`, `mkdir`, `rename`, `unlink` — has no seam and takes no
 * probe. Those calls are the guarantee, and a guarantee that can be faked in a
 * test is not one.
 */
export interface DestinationProbe {
  /** What is at `absolutePath` itself, a link as a link; null when nothing is there. */
  lstat(absolutePath: string): Promise<EntryIdentity | null>;
  /** The names `folder` lists; rejects when it cannot be read. */
  readdir(folder: string): Promise<string[]>;
}

/** The real disk — what every caller uses. */
export const diskProbe: DestinationProbe = {
  lstat: lstatOrNull,
  readdir: (folder) => fs.readdir(folder),
};

/**
 * The one reading of "is this destination the source under another name?".
 *
 * `lstat`, never `stat`: a link at the destination is an entry in its own
 * right.
 */
export async function inspectDestination(
  oldAbsolute: string,
  newAbsolute: string,
  probe: DestinationProbe = diskProbe,
): Promise<DestinationVerdict> {
  const destination = await probe.lstat(newAbsolute);
  if (destination === null) return { state: 'free' };
  const source = await probe.lstat(oldAbsolute);
  // A source that is not there is left to the move's own ENOENT — "there is
  // nothing to move" is the truer answer than "the name is taken".
  if (source === null) return { state: 'free' };
  if (await isSelfRename(oldAbsolute, newAbsolute, source, destination, probe)) return { state: 'self' };
  return { state: 'taken', kind: destination.isDirectory() ? 'folder' : 'file' };
}

/**
 * Whether the destination is the SOURCE, seen under a second spelling of the
 * one name — the thing a case-insensitive filesystem does and the only reason
 * a move onto an existing entry is ever allowed.
 *
 * Identity alone (same device, same inode) does not show it: two hard links
 * are one inode under two names a user sees separately in the tree, and a
 * move onto one of them takes that name away. Neither does folded path
 * equality on its own, for the same reason in the other direction — on a
 * CASE-SENSITIVE disk `deal.md` and `Deal.md` fold together as strings while
 * being two real entries, hard-linked or not.
 *
 * What actually distinguishes them is the directory: a filesystem that folds
 * the two spellings has ONE entry to list, and a filesystem that does not has
 * two. So the parent is read and the two spellings are counted. One entry
 * means the filesystem handed us the source itself, whatever spelling was
 * asked for; two means two names, and the move is a clash.
 *
 * Paths in different folders are two entries by definition — but "different
 * folder" is itself a question for the filesystem and not for the strings: the
 * same volume that folds `notes.md` into `Notes.md` folds `Sales` into
 * `sales`, so `Sales/notes.md` → `sales/Notes.md` is one folder, one entry and
 * one rename. The parents are compared by identity for that reason.
 *
 * Two cases never reach the listing at all, because there are no two
 * spellings in them to count: `oldAbsolute === newAbsolute`, and the pair
 * whose basenames are identical and whose only difference is the parent's
 * spelling. Both are one entry by construction.
 *
 * Everything above happens only on a volume that folds case, so on the Linux
 * this is built and tested on it is reached by nothing real. That is what
 * {@link DestinationProbe} is for — read its note before changing any of this,
 * because the tests that hold these rules up run against a stand-in volume,
 * not against the disk under them.
 */
async function isSelfRename(
  oldAbsolute: string,
  newAbsolute: string,
  source: EntryIdentity,
  destination: EntryIdentity,
  probe: DestinationProbe,
): Promise<boolean> {
  if (source.dev !== destination.dev || source.ino !== destination.ino) return false;
  if (oldAbsolute === newAbsolute) return true;
  if (!foldsTogether(oldAbsolute, newAbsolute)) return false;
  const folder = path.dirname(oldAbsolute);
  if (!(await sameFolder(folder, path.dirname(newAbsolute), probe))) return false;
  // One folder and one NAME: only the parent's spelling changed
  // (`Sales/notes.md` → `sales/notes.md`), so there is nothing for the listing
  // to count — asking it whether two identical basenames are both present
  // would answer yes and read the entry as a clash with itself.
  if (path.basename(oldAbsolute) === path.basename(newAbsolute)) return true;
  let entries: string[];
  try {
    entries = await probe.readdir(folder);
  } catch {
    // The parent cannot be listed, so nothing here can be shown to be one
    // entry. Refusing is the safe reading: at worst a case-only rename on an
    // unreadable folder is turned away, and nothing is ever overwritten.
    return false;
  }
  const listed = new Set(entries);
  return !(listed.has(path.basename(oldAbsolute)) && listed.has(path.basename(newAbsolute)));
}

/**
 * Whether two directory paths are the one directory. String equality first,
 * because that is the answer almost every time and costs nothing; otherwise
 * the filesystem decides, so a volume that folds `Sales` and `sales` is not
 * read as two folders.
 */
async function sameFolder(a: string, b: string, probe: DestinationProbe): Promise<boolean> {
  if (a === b) return true;
  const [statA, statB] = await Promise.all([probe.lstat(a), probe.lstat(b)]);
  if (statA === null || statB === null) return false;
  return statA.dev === statB.dev && statA.ino === statB.ino;
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
    await landFolder(oldAbsolute, newAbsolute, destinationLabel);
    return;
  }
  await linkThenUnlink(oldAbsolute, newAbsolute, destinationLabel);
}

/**
 * `link` + `unlink`: the destination is created atomically or not at all, and
 * the source only goes away once it exists under both names, so no reader ever
 * sees a partial file at the new name.
 *
 * Where hard links are unavailable — `EPERM` or `ENOSYS` on some network and
 * FUSE mounts, FAT — the fallback is `claimThenRename`, NOT a plain rename: a
 * rename replaces, and falling back to one would hand back exactly the
 * overwrite this module exists to prevent, on the filesystems least likely to
 * be tested.
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
    await claimThenRename(oldAbsolute, newAbsolute, destinationLabel);
    return;
  }
  await fs.unlink(oldAbsolute);
}

/**
 * The no-clobber move for a file on a filesystem with no hard links: `wx`
 * claims the name — `open` with `O_EXCL`, which every filesystem Node runs on
 * implements atomically and which fails with `EEXIST` if anything is there —
 * and the rename then replaces the empty file we own rather than someone
 * else's. A rename that fails anyway gives the claim back.
 *
 * The cost against `link` + `unlink` is that the destination is briefly an
 * empty file, which is why this is the fallback and not the first choice.
 *
 * Exported for the same reason as {@link landFolder}: the path only runs on
 * filesystems without hard links, so a test has to call it directly to cover
 * it at all.
 */
export async function claimThenRename(
  oldAbsolute: string,
  newAbsolute: string,
  destinationLabel: string,
): Promise<void> {
  let claim: FileHandle;
  try {
    claim = await fs.open(newAbsolute, 'wx');
  } catch (err) {
    if (codeOf(err) === 'EEXIST') throw await takenError(newAbsolute, destinationLabel);
    throw err;
  }
  await claim.close();
  try {
    await fs.rename(oldAbsolute, newAbsolute);
  } catch (err) {
    await fs.unlink(newAbsolute).catch(() => undefined);
    throw err;
  }
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
 *
 * Exported without the look `renameNoReplace` does first, so the claim and its
 * rollback — the half that only runs when a name is taken in the moment
 * between the two — can be driven directly by a test instead of by a race.
 */
export async function landFolder(
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
