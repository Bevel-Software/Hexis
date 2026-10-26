import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { PathNotFoundError, WorkflowValidationError } from '../../shared/domain-errors.js';
import { sanitizedPath } from '../../shared/printable.js';
import { hasControlCharacter } from '../kb-fs/index.js';
import { isAbsence } from '../../shared/fs.contract.js';
import { logger } from '../../shared/logging.js';

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
 * every other tool refuses (`tmpRefReadOnlyRefusal`). A plain `tmp/…` path is
 * not that ref and never will be: `tmp` is a legal folder name inside a
 * repository, and the normaliser's rule is what keeps every other path in it.
 *
 * The ref is workspace-scoped: it is resolved against the workspace of the
 * branch the call names, exactly like a repository path. It names ONE file —
 * no folder, no listing — and nothing outside that workspace's `tmp/` folder
 * is reachable through it, links included. Every resolution goes through
 * {@link resolveTmpRef}; there is no second reader of the folder.
 *
 * Entries live for {@link TMP_MAX_AGE_MS} after their last modification, then
 * the platform's periodic sweep removes them ({@link sweepTmpFolder},
 * scheduled by {@link TmpSweeper}).
 */

/** The ref's prefix. A ref is `__tmp__/<path inside the workspace's tmp folder>`. */
export const TMP_REF_PREFIX = '__tmp__/';

/** The folder the ref reaches, beside the checkout in every workspace directory. */
export const WORKSPACE_TMP_DIR = 'tmp';

/** How long an entry of a `tmp/` folder lives after its last modification: seven days. */
export const TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How often the platform sweeps every workspace's `tmp/` folder: hourly. */
export const TMP_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Whether a tool argument is a tmp ref rather than a repository path: the
 * prefix as written, or the prefix's own folder name alone (which names the
 * folder, and is refused as such by {@link resolveTmpRef}). A path that only
 * CONTAINS the name — `/__tmp__/x`, `knowledge-base/__tmp__/x` — is an
 * ordinary repository path.
 */
export function isTmpRef(value: unknown): boolean {
  return typeof value === 'string' && (value === TMP_REF_PREFIX.slice(0, -1) || value.startsWith(TMP_REF_PREFIX));
}

/** A ref that breaks one of the rules, with the rule named. */
function invalidRef(ref: string, rule: string): WorkflowValidationError {
  const shown = sanitizedPath(ref);
  return new WorkflowValidationError(`"${shown}" is not a valid tmp ref: ${rule}`, { kind: 'tmp-ref-invalid', path: shown });
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
 * THE resolution of a ref, against one workspace directory: the file's
 * absolute path and its stat, or a refusal. Every read of the folder starts
 * here.
 *
 * - The lexical rules first ({@link tmpRefSegments}), before the disk is
 *   asked anything.
 * - Nothing there is a {@link PathNotFoundError} naming the REF, never the
 *   path on disk — the answer every file tool turns into its ordinary 404.
 * - The file's REAL path must lie inside the folder's real path, so a link —
 *   anywhere along the ref — that leads out of the folder is refused rather
 *   than followed. A link that stays inside is the file it points at.
 * - A folder is refused by the rule, never listed.
 */
export async function resolveTmpRef(workspaceDir: string, ref: string): Promise<{ absolutePath: string; stat: Stats }> {
  const segments = tmpRefSegments(ref);
  const tmpDir = path.join(workspaceDir, WORKSPACE_TMP_DIR);
  const absent = (err: unknown): never => {
    if (isAbsence(err)) throw new PathNotFoundError(ref);
    throw err;
  };
  // The folder itself must BE a folder of this workspace, not a link to one
  // somewhere else: the containment below is judged against it.
  if (!(await fs.lstat(tmpDir).catch(absent)).isDirectory()) throw new PathNotFoundError(ref);
  const realTmp = await fs.realpath(tmpDir).catch(absent);
  const real = await fs.realpath(path.join(tmpDir, ...segments)).catch(absent);
  if (!real.startsWith(realTmp + path.sep)) {
    throw invalidRef(ref, 'it goes through a link that leads out of the workspace\'s tmp folder, and links out of it are never followed.');
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

/** The bytes of the one file a ref names in `workspaceDir`'s tmp folder (see {@link resolveTmpRef}). */
export async function readTmpRef(workspaceDir: string, ref: string): Promise<Buffer> {
  const { absolutePath } = await resolveTmpRef(workspaceDir, ref);
  return fs.readFile(absolutePath).catch((err: unknown) => {
    // Swept or replaced between the resolve and the read: the same answer a
    // moment later would give, still naming the ref.
    if (isAbsence(err)) throw new PathNotFoundError(ref);
    throw err;
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
export async function statTmpRef(workspaceDir: string, ref: string): Promise<TmpFileStat> {
  const { stat } = await resolveTmpRef(workspaceDir, ref);
  return { name: ref.slice(ref.lastIndexOf('/') + 1), size: stat.size, createdAt: stat.birthtime, modifiedAt: stat.mtime };
}

/**
 * Why a tool refuses a tmp ref in an input that is not one of the four that
 * take it: the folder is read-only through the ref, and a file is kept by
 * copying it into the repository. A 400 with a `kind` to branch on, before
 * any gate, lock or write.
 */
export function tmpRefReadOnlyRefusal(ref: string, tool: string): WorkflowValidationError {
  const shown = sanitizedPath(ref);
  return new WorkflowValidationError(
    `"${shown}" is a tmp ref, and ${tool} does not take one there: the workspace's tmp folder is read-only through ` +
      'the ref. read_file, file_stat and grep read the one file it names; to keep the file, copy_file it to a ' +
      'repository path (the ref as `src`, the repository path as `dest`).',
    { kind: 'tmp-ref-read-only', path: shown, tool },
  );
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
 */
export async function sweepTmpFolder(workspaceDir: string, maxAgeMs: number, now: number): Promise<string[]> {
  const tmpDir = path.join(workspaceDir, WORKSPACE_TMP_DIR);
  try {
    // `lstat` the folder itself: a `tmp` that is a link is not a folder of
    // this workspace's to sweep.
    if (!(await fs.lstat(tmpDir)).isDirectory()) return [];
  } catch (err) {
    if (isAbsence(err)) return [];
    throw err;
  }
  const removed: string[] = [];
  await sweepDir(tmpDir, '', maxAgeMs, now, removed);
  return removed;
}

/** One folder of {@link sweepTmpFolder}'s walk; answers whether the folder is empty afterwards. */
async function sweepDir(dir: string, rel: string, maxAgeMs: number, now: number, removed: string[]): Promise<boolean> {
  const names = await fs.readdir(dir);
  let left = names.length;
  for (const name of names) {
    const entry = path.join(dir, name);
    const entryRel = rel === '' ? name : `${rel}/${name}`;
    try {
      const stat = await fs.lstat(entry);
      const old = now - stat.mtimeMs > maxAgeMs;
      if (stat.isDirectory()) {
        // Its age is read BEFORE its contents go: removing them moves it.
        if ((await sweepDir(entry, entryRel, maxAgeMs, now, removed)) && old) {
          await fs.rmdir(entry);
          removed.push(entryRel);
          left -= 1;
        }
        continue;
      }
      if (!old) continue;
      // A file, or a link removed as the link.
      await fs.unlink(entry);
      removed.push(entryRel);
      left -= 1;
    } catch (err) {
      // Gone mid-sweep is what the sweep wanted; anything else spoils one
      // entry, not the sweep.
      if (isAbsence(err)) left -= 1;
      else log.warn('could not sweep a tmp entry:', { err, entry: sanitizedPath(entryRel) });
    }
  }
  return left === 0;
}

/**
 * The periodic sweep of every workspace's `tmp/` folder, on a timer.
 *
 * Started with the graph (`startCore`) and stopped with it (`stopCore`):
 * the timer is cleared and a sweep in flight is awaited (`drainSweep`), so a
 * stopped graph leaves no timer behind and the next graph for the same
 * workspaces root never finds this one's sweep still walking it. The first
 * sweep runs at start, not one interval later, so what a previous process
 * left past its age goes without waiting. The timer is `unref`'d: nothing
 * here is worth keeping a process alive for.
 */
export class TmpSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping: Promise<void> | null = null;

  constructor(private readonly sweep: () => Promise<unknown>) {}

  /** Sweep now, and every `intervalMs` after. Idempotent. */
  startSweeping(intervalMs: number = TMP_SWEEP_INTERVAL_MS): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  /** Clear the timer. A sweep already running finishes; {@link drainSweep} waits for it. */
  stopSweeping(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wait for the sweep in flight, if any. */
  async drainSweep(): Promise<void> {
    await this.sweeping;
  }

  /** One sweep, unless one is still running; its failure is logged. */
  private tick(): void {
    if (this.sweeping) return;
    const running = this.sweep()
      .then(() => undefined)
      .catch((err: unknown) => log.warn('could not sweep the workspaces\' tmp folders:', { err }))
      .finally(() => {
        if (this.sweeping === running) this.sweeping = null;
      });
    this.sweeping = running;
  }
}
