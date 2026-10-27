import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { PathNotFoundError, WorkflowDomainError, WorkflowValidationError } from '../../shared/domain-errors.js';
import { assertWithinDirectory } from '../../shared/path-containment.js';
import { sanitizedPath } from '../../shared/printable.js';
import { hasControlCharacter, TMP_REF_PREFIX } from '../kb-fs/index.js';
import { isAbsence, type ITreeWalker } from '../../shared/fs.contract.js';
import { logger } from '../../shared/logging.js';
import { lstatOrNull } from '../../shared/rename-no-replace.js';

const log = logger('workspace-tmp');

/**
 * A workspace's `tmp/` folder, reached through a reserved ref.
 *
 * Every workspace directory holds its checkout and, beside it, a `tmp/`
 * folder: the chat stages attachments there, the SharePoint reader stages
 * documents there, and nothing in it is ever committed. The file tools place
 * every path under the checkout (see `kb-fs/repo-path.ts`), so the folder is
 * named by a REF instead — `__tmp__/<path>` — which `read_file`, `file_stat`,
 * `grep` and `copy_file` (as its source) accept beside a repository path, and
 * every other tool refuses (`kb-fs/tmp-ref.ts`, the one admission gate every
 * tool's path inputs pass). A plain `tmp/…` path is not that ref and never
 * will be: `tmp` is a legal folder name inside a repository, and the
 * normaliser's rule is what keeps every other path in it.
 *
 * The ref is scoped twice. To the WORKSPACE: it is resolved against the
 * workspace of the branch the call names, exactly like a repository path. And
 * to the CALLER: what a person stages lands under their own folder,
 * `tmp/<owner id>/` ({@link stageTmpRef}, the one way in), and a ref resolves
 * inside the caller's own folder and nowhere else ({@link resolveTmpRef}). A
 * file somebody else staged is therefore not there — the plain not-found,
 * the same answer as for a file that never existed — rather than something an
 * access rule has to refuse: the folder is outside the repository, where no
 * `access.md` governs anything, and the only person a staged attachment is
 * for is the one who attached it. The ref names ONE file — no folder, no
 * listing — and nothing outside the caller's folder is reachable through it,
 * links included. Every resolution goes through {@link resolveTmpRef}; there
 * is no second reader of the folder.
 *
 * Entries live for {@link TMP_MAX_AGE_MS} after their last modification, then
 * the platform's periodic sweep removes them ({@link sweepTmpFolder},
 * scheduled by {@link TmpSweeper}) — or sooner, when a distribution clears a
 * workspace's whole `tmp/` after a run of its own (`clearTmp`): "up to seven
 * days" is the promise, not "seven days".
 */

/** The folder the ref reaches, beside the checkout in every workspace directory. */
export const WORKSPACE_TMP_DIR = 'tmp';

/** How long an entry of a `tmp/` folder lives after its last modification: seven days. */
export const TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How often the platform sweeps every workspace's `tmp/` folder: hourly. */
export const TMP_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** A ref that breaks one of the rules, with the rule named. */
function invalidRef(ref: string, rule: string): WorkflowValidationError {
  const shown = sanitizedPath(ref);
  return new WorkflowValidationError(`"${shown}" is not a valid tmp ref: ${rule}`, { kind: 'tmp-ref-invalid', path: shown });
}

/**
 * The folder of one owner inside a workspace's `tmp/`: `tmp/<owner id>/`.
 * The id is an account id, which the platform mints and which is one path
 * segment by construction; one that is not — empty, a separator in it, a
 * `.`/`..`, a control character — is a programming error, never a file to
 * look for, and is refused as one.
 */
function ownerFolder(workspaceDir: string, ownerId: string): string {
  if (
    ownerId === '' ||
    ownerId === '.' ||
    ownerId === '..' ||
    ownerId.includes('/') ||
    ownerId.includes('\\') ||
    hasControlCharacter(ownerId) ||
    ownerId.length > 255
  ) {
    throw new Error(`Invalid tmp owner id "${sanitizedPath(ownerId)}": an owner's tmp folder is one path segment.`);
  }
  return path.join(workspaceDir, WORKSPACE_TMP_DIR, ownerId);
}

/**
 * What a failed look at the folder answers, naming the REF and never the path
 * on disk — the raw error (which carries that path) is the server log's, not
 * the caller's: nothing there is the ordinary not-found; a loop of links is
 * refused by the link rule; anything else (a permission, an I/O error) is a
 * 500 that says the ref could not be read.
 */
function tmpRefFailure(ref: string, err: unknown): Error {
  if (isAbsence(err)) return new PathNotFoundError(ref);
  const shown = sanitizedPath(ref);
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ELOOP') {
    return invalidRef(ref, 'it goes through a link that cannot be followed (a link that leads back to itself).');
  }
  log.warn('could not read a tmp ref:', { err, ref: shown });
  return new WorkflowDomainError(`"${shown}" could not be read from the workspace's tmp folder.`, 500, {
    kind: 'tmp-ref-unreadable',
    path: shown,
  });
}

/**
 * The ref's path inside the `tmp/` folder, as segments — or the refusal that
 * names the rule it breaks. Lexical only: the folder and link rules need the
 * disk and are {@link resolveTmpRef}'s.
 */
function tmpRefSegments(ref: string): string[] {
  const rest = ref.startsWith(TMP_REF_PREFIX) ? ref.slice(TMP_REF_PREFIX.length) : '';
  // First, because the refusal below would otherwise quote the character
  // that forges a second line — and a line break is a separator to git and
  // to every line-oriented log this ref may reach.
  if (hasControlCharacter(ref)) {
    throw invalidRef(ref, 'it contains a control character (a line break, a NUL or another invisible byte), which is part of no file name.');
  }
  if (rest === '') {
    throw invalidRef(ref, `it names the tmp folder itself. A tmp ref names one file: \`${TMP_REF_PREFIX}<path to the file>\`.`);
  }
  if (rest.startsWith('/') || /^[A-Za-z]:/.test(rest)) {
    throw invalidRef(ref, 'the path after the prefix is absolute. It is a path inside the workspace\'s tmp folder, written without a leading slash.');
  }
  if (rest.includes('\\')) {
    throw invalidRef(ref, 'it contains a backslash. Separate folders with `/`.');
  }
  if (rest.endsWith('/')) {
    throw invalidRef(ref, 'it ends with `/`, which names a folder. A tmp ref names one file; the tmp folder is not listed.');
  }
  const segments = rest.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw invalidRef(ref, 'it contains a `.` or `..` segment (or an empty one). A tmp ref names one file inside the workspace\'s tmp folder and cannot climb out of it.');
  }
  return segments;
}

/**
 * THE resolution of a ref, against one owner's folder in one workspace
 * directory: the file's absolute path and its stat, or a refusal. Every read
 * of the folder starts here.
 *
 * - The lexical rules first ({@link tmpRefSegments}), before the disk is
 *   asked anything.
 * - Nothing there — the owner's folder included, which a person who has
 *   staged nothing does not have — is a {@link PathNotFoundError} naming the
 *   REF, never the path on disk: the answer every file tool turns into its
 *   ordinary 404. What another person staged is "nothing there" too. Every
 *   other failure names the ref alone as well ({@link tmpRefFailure}).
 * - The file's REAL path must lie inside the owner's folder's real path, so a
 *   link — anywhere along the ref — that leads out of it (into another
 *   owner's folder included) is refused rather than followed. A link that
 *   stays inside is the file it points at.
 * - A folder is refused by the rule, never listed.
 */
export async function resolveTmpRef(
  workspaceDir: string,
  ownerId: string,
  ref: string,
): Promise<{ absolutePath: string; stat: Stats }> {
  const segments = tmpRefSegments(ref);
  const ownerDir = ownerFolder(workspaceDir, ownerId);
  const absent = (err: unknown): never => {
    throw tmpRefFailure(ref, err);
  };
  // The folder itself must BE a folder of this workspace, not a link to one
  // somewhere else: the containment below is judged against it.
  if ((await lstatOrNull(ownerDir).catch(absent))?.isDirectory() !== true) throw new PathNotFoundError(ref);
  const realOwnerDir = await fs.realpath(ownerDir).catch(absent);
  const real = await fs.realpath(path.join(ownerDir, ...segments)).catch(absent);
  // THE containment check (shared/path-containment.ts), on the real paths;
  // its refusal is answered as the link rule, naming the ref. The folder
  // itself passes it, and is refused below as a folder.
  try {
    assertWithinDirectory(real, realOwnerDir);
  } catch {
    throw invalidRef(ref, 'it goes through a link that leads out of your tmp folder, and links out of it are never followed.');
  }
  const stat = await fs.stat(real).catch(absent);
  if (stat.isDirectory()) {
    throw invalidRef(ref, 'it names a folder. A tmp ref names one file; the tmp folder is not listed.');
  }
  if (!stat.isFile()) {
    throw invalidRef(ref, 'it names something that is not a file.');
  }
  return { absolutePath: real, stat };
}

/** The bytes of the one file a ref names in `ownerId`'s folder of `workspaceDir`'s tmp (see {@link resolveTmpRef}). */
export async function readTmpRef(workspaceDir: string, ownerId: string, ref: string): Promise<Buffer> {
  const { absolutePath } = await resolveTmpRef(workspaceDir, ownerId, ref);
  return fs.readFile(absolutePath).catch((err: unknown) => {
    // Swept or replaced between the resolve and the read: the same answer a
    // moment later would give, still naming the ref.
    throw tmpRefFailure(ref, err);
  });
}

/** What `file_stat` reports about a staged file: the fields a repository file's stat carries. */
export interface TmpFileStat {
  /** The file's own name, the last segment of the ref. */
  name: string;
  size: number;
  createdAt: Date;
  modifiedAt: Date;
}

/** The stat of the one file a ref names (see {@link resolveTmpRef}). */
export async function statTmpRef(workspaceDir: string, ownerId: string, ref: string): Promise<TmpFileStat> {
  const { stat } = await resolveTmpRef(workspaceDir, ownerId, ref);
  return { name: ref.slice(ref.lastIndexOf('/') + 1), size: stat.size, createdAt: stat.birthtime, modifiedAt: stat.mtime };
}

/**
 * Stage `bytes` at `relativePath` in `ownerId`'s folder of `workspaceDir`'s
 * tmp, and answer the ref the owner reads it back with: the ONE way a file
 * gets into the folder the ref reaches, so the convention — one folder per
 * owner, the file's path inside it — is this function's and no stager's.
 * `relativePath` obeys a ref's own rules (one file, no `..`, no absolute
 * path, no backslash, no control character); the refusal names the rule.
 * Replaces what is at the path: a staged file is the stager's own scratch,
 * and the chat names uploads by their content. Never writes through a link
 * that leads out of the owner's folder.
 */
export async function stageTmpRef(workspaceDir: string, ownerId: string, relativePath: string, bytes: Uint8Array): Promise<string> {
  const ref = TMP_REF_PREFIX + relativePath;
  const segments = tmpRefSegments(ref);
  const ownerDir = ownerFolder(workspaceDir, ownerId);
  const absolutePath = path.join(ownerDir, ...segments);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  // The parent is real and inside the owner's folder, or a link somewhere in
  // the path would carry the bytes out of it.
  const [realOwnerDir, realParent] = await Promise.all([fs.realpath(ownerDir), fs.realpath(path.dirname(absolutePath))]);
  try {
    assertWithinDirectory(realParent, realOwnerDir);
  } catch {
    if (realParent !== realOwnerDir) {
      throw invalidRef(ref, 'it goes through a link that leads out of your tmp folder, and links out of it are never followed.');
    }
  }
  await fs.writeFile(path.join(realParent, segments[segments.length - 1]!), bytes);
  return ref;
}

/**
 * Remove every file of one `tmp/` folder, at any depth, whose last
 * modification is older than `maxAgeMs`, and every folder in it that the
 * sweep leaves empty and that was itself older than that before the sweep
 * touched it. Judged per FILE, because the stagers keep a long-lived folder
 * each (`chat-uploads/`, …) whose own mtime moves with every new upload: a
 * folder judged as a whole would keep an old file for as long as anyone kept
 * uploading beside it. Everything is judged by its own `lstat`, and a link is
 * removed as the link, never followed. The `tmp/` folder itself stays. A
 * folder that is not there is nothing to sweep. Returns the paths removed,
 * relative to `tmp/`.
 *
 * The tree is read by THE walk (`walker`, see `shared/fs.contract.ts`), not a
 * loop of its own: its files, its other entries (a link, a socket — never
 * entered) and its folders are collected, each folder's age read as it is
 * listed, so before anything in it goes. A folder that cannot be listed is
 * the walk's hole: logged, and walked around. The removals follow the walk —
 * the entries first, then the folders deepest first, so a folder emptied by
 * the sweep is judged after its contents.
 *
 * `signal` ends the sweep early: once it is aborted the walk stops listing
 * and nothing more is removed — it is asked again right before each removal,
 * after every awaited look — and what is already gone is returned.
 */
export async function sweepTmpFolder(
  walker: ITreeWalker,
  workspaceDir: string,
  maxAgeMs: number,
  now: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const tmpDir = path.join(workspaceDir, WORKSPACE_TMP_DIR);
  // `lstat` the folder itself: a `tmp` that is a link is not a folder of
  // this workspace's to sweep (the walk would follow it). Not there is
  // nothing to sweep.
  if ((await lstatOrNull(tmpDir))?.isDirectory() !== true) return [];
  const join = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);
  const entries: string[] = [];
  const oldDirs: string[] = [];
  const stopped = (): boolean => signal?.aborted === true;
  // The entry's own `lstat` (shared/rename-no-replace.ts), or null when it is
  // gone; any other failure spoils that one entry: logged, and left alone.
  const entryStat = async (rel: string): Promise<Stats | null> => {
    try {
      return await lstatOrNull(path.join(tmpDir, rel));
    } catch (err) {
      log.warn('could not stat a tmp entry:', { err, entry: sanitizedPath(rel) });
      return null;
    }
  };
  await walker.walk(tmpDir, { until: stopped }, [
    {
      async onDir(rel) {
        if (rel === '') return;
        // Its age is read BEFORE its contents go: removing them moves it.
        const stat = await entryStat(rel);
        if (stat && now - stat.mtimeMs > maxAgeMs) oldDirs.push(rel);
      },
      onFile(dir, name) {
        entries.push(join(dir, name));
      },
      onOther(dir, entry) {
        entries.push(join(dir, entry.name));
      },
      onHole(rel, err) {
        log.warn('could not list a tmp folder:', { err, folder: sanitizedPath(rel) });
      },
    },
  ]);
  const removed: string[] = [];
  const attempt = async (rel: string, remove: (abs: string) => Promise<void>): Promise<void> => {
    try {
      await remove(path.join(tmpDir, rel));
      removed.push(rel);
    } catch (err) {
      // Gone mid-sweep is what the sweep wanted, and a folder something is
      // still in stays; anything else spoils one entry, not the sweep.
      const code = (err as { code?: unknown } | null)?.code;
      if (!isAbsence(err) && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
        log.warn('could not sweep a tmp entry:', { err, entry: sanitizedPath(rel) });
      }
    }
  };
  for (const rel of entries) {
    if (stopped()) return removed;
    const stat = await entryStat(rel);
    if (!stat || now - stat.mtimeMs <= maxAgeMs) continue;
    // Asked again AFTER the awaited look: a stop that came while it ran
    // removes nothing more, this entry included.
    if (stopped()) return removed;
    // A file, or a link removed as the link.
    await attempt(rel, (abs) => fs.unlink(abs));
  }
  // Walk order lists a folder before what is in it, so the reverse is deepest first.
  for (const rel of oldDirs.reverse()) {
    if (stopped()) return removed;
    await attempt(rel, (abs) => fs.rmdir(abs));
  }
  return removed;
}

/**
 * The periodic sweep of every workspace's `tmp/` folder, on a timer.
 *
 * Started with the graph (`startCore`) and stopped with it (`stopCore`):
 * stopping clears the timer and CANCELS the sweep in flight — its signal is
 * aborted, so it removes nothing more and ends at the next entry it would
 * have looked at — and `drainSweep` waits for it to end. `stopCore` bounds
 * that wait by its own deadline, like every other drain there: a sweep stuck
 * inside one filesystem call (a hung mount) can outlive the wait, but it
 * removes nothing once that call returns. The first sweep runs at start, not
 * one interval later, so what a previous process left past its age goes
 * without waiting. The timer is `unref`'d: nothing here is worth keeping a
 * process alive for.
 */
export class TmpSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping: Promise<void> | null = null;
  private stop: AbortController | null = null;

  constructor(private readonly sweep: (signal: AbortSignal) => Promise<unknown>) {}

  /** Sweep now, and every `intervalMs` after. Idempotent. */
  startSweeping(intervalMs: number = TMP_SWEEP_INTERVAL_MS): void {
    if (this.timer) return;
    this.stop = new AbortController();
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  /** Clear the timer and cancel the sweep in flight; {@link drainSweep} waits for it to end. */
  stopSweeping(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stop?.abort();
    this.stop = null;
  }

  /** Wait for the sweep in flight, if any, to end. */
  async drainSweep(): Promise<void> {
    await this.sweeping;
  }

  /** One sweep, unless one is still running; its failure is logged. */
  private tick(): void {
    if (this.sweeping || !this.stop) return;
    const running = this.sweep(this.stop.signal)
      .then(() => undefined)
      .catch((err: unknown) => log.warn('could not sweep the workspaces\' tmp folders:', { err }))
      .finally(() => {
        if (this.sweeping === running) this.sweeping = null;
      });
    this.sweeping = running;
  }
}
