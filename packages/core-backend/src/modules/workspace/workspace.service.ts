import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import { logger } from '../../shared/logging.js';

const log = logger('workspace');
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { AuthUser, IWorkspaceService, WorkspaceInfo, FileTreeEntry } from '@bevel-software/platform-shared';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  validateRelativePath,
  FOLDER_PLACEHOLDER,
  isFolderPlaceholder,
  entryExistsMessage,
  type ExistingEntryKind,
} from '@bevel-software/platform-shared';
import { isAbsence, type IgnoreRules, type ITreeWalker, type TreeWalkOptions } from '../../shared/fs.contract.js';
import { BevelIgnoreStack, PathHeldError, assertRepoRootNameFree, normalizeWorkspacePath, assertValidBranchName, normalizeRepositoryAddress, sameRepository } from '../kb-fs/index.js';
import {
  DestinationTakenError,
  inspectDestination,
  renameNoReplace,
} from '../../shared/rename-no-replace.js';
import { GitRunError, type IGitRunner } from '../../shared/git.contract.js';
import type { KbContext } from '../../shared/kb-context.js';
import { NodeGitRunner } from '../version-control/index.js';
import { assertWithinDirectory } from '../../shared/path-containment.js';
import { assertNoGitInternalsSegment, assertNotGitInternals, hasGitInternalsSegment } from '../../shared/git-internals.js';
import { planZipEntries, type ZipPlanLimits, type ZipPlanSkip } from './zip-entry-rules.js';
import { landingObstacle, type LandingObstacle } from './landing-obstacle.js';
import {
  GitInternalsError,
  PathNotFoundError,
  PathTraversalError,
  UnreadableArchiveError,
  VersionControlValidationError,
} from '../../shared/domain-errors.js';
import { workspaceIdForBranch, branchForWorkspaceId } from '../../shared/workspace-id.js';
import {
  BranchNotFoundError,
  PushNeedsAgentResolutionError,
  RemoteBranchGoneError,
  VersionControlDomainError,
  isMissingRemoteBranchFailure,
} from '../../shared/domain-errors.js';
import { redactSecret, urlQuerySecrets } from '../../shared/redact-secret.js';
import { setAsideClone, setAsideRepository, setAsideRootFor, setAsideStamp } from './set-aside-clone.js';
import { workingCopyShape } from './kb-repository.js';
import { readTmpRef, stageTmpRef, statTmpRef, sweepTmpFolder, TMP_MAX_AGE_MS, type TmpFileStat } from './workspace-tmp.js';
import type { IKbRepository } from './kb-repository.contract.js';
import {
  cloneCredentialConfigArgs,
  credentialHelperValue,
  cloneTrackingConfigArgs,
  SAFE_IMPLICIT_FETCH_ARGS,
} from '../kb-fs/index.js';
import type { IDiffService } from '../diff/index.js';

/** One held path turn: the settled tail of the nested mutations launched inside it. */
interface HeldTurn {
  tail: Promise<void>;
}

/**
 * Workspaces are per-branch, not per-user (PLAN §3). One on-disk clone per
 * branch name, shared by every user editing that branch — coordination of
 * concurrent edits lives in the file-lock service, not in giving each user
 * their own clone.
 *
 * Workspace identity is the URL-encoded branch name. The mapping is
 * deterministic: every caller (backend, frontend, agent) can compute the
 * workspace id from a branch name and vice versa without a DB round-trip.
 *
 * Directory layout on disk:
 *   <workspacesRoot>/
 *     <encodeURIComponent(branch)>/
 *       knowledge-base/           # a worktree of the KB repository, on <branch>
 *   <repository>/knowledge-base.git  # the one repository (see `kb-repository.ts`)
 *
 * Bootstrap is lazy: the first call to `getOrCreateForBranch(branch)` adds
 * the branch's worktree, which copies no history. Subsequent callers — whether
 * the same user or a different one — share the same directory and the same
 * git operations are serialised through the workspace mutex elsewhere in the
 * codebase.
 *
 * A checkout folder that is still a full CLONE (from a release before
 * worktrees, which the KB startup phase converts at boot) is served as it is
 * until it is converted: every method here accepts both shapes.
 */

export interface UnzipResult {
  /** Workspace-relative directory the archive was extracted into. */
  destination: string;
  /** Workspace-relative paths of files that were written. */
  extracted: string[];
  /** Entry names from the archive that were not extracted, with the reason (e.g. an invalid name, a size cap). macOS metadata is dropped without a report. */
  skipped: { path: string; reason: string }[];
}

/**
 * Where `unzipFile` lands an archive's files: `LockingFilesystem.writeFiles`,
 * which takes every path's lock before it writes a byte and commits the whole
 * set as one change. A lock another holds refuses the batch with nothing
 * written ({@link PathHeldError}). A lock the lock's own gates refuse is handed
 * to `refused`, which skips that entry or refuses the batch. A write or commit
 * that fails commits nothing, with one exception: a commit whose push needs
 * resolution (`PushNeedsAgentResolutionError`) has landed, and only its sharing
 * is pending.
 */
export interface ArchiveLanding {
  writeFiles(
    writes: { path: string; content: Buffer }[],
    summary: string,
    deletes?: string[],
    /** Run with every lock held, after the locks' gates and before any byte lands: the writes that may still land. */
    check?: (writes: readonly { path: string; content: Buffer }[]) => Promise<{ path: string; content: Buffer }[]>,
    refused?: (path: string, err: unknown) => void,
  ): Promise<unknown>;
}

/**
 * An archive refused whole: nothing in it was written or committed, and no
 * lock taken for it is still held.
 *
 * Raised by an archive's judge ({@link ArchiveEntryJudge}) for an entry that
 * decides the archive rather than only itself: a file no archive may carry,
 * or one of the archive's own access rules that cannot land. `entry` is the
 * workspace path (or, when it has none, the name in the archive) of the entry
 * that decided it.
 */
export class ArchiveRefusedError extends VersionControlDomainError {
  readonly kind = 'archive-refused' as const;
  constructor(
    readonly entry: string,
    message: string,
    status: number,
  ) {
    super(message, status, { kind: 'archive-refused', entry });
    this.name = 'ArchiveRefusedError';
  }
}

/**
 * How one archive's entries are judged, by both doors that land an archive
 * (the agent `unzip` tool and the app's unzip route, through `unzipFile`) and
 * by `apply_file_upload`. An extraction first asks two questions, each
 * before anything on disk at its path is looked at:
 *
 *  - `archive`: may the caller read the archive at `wsPath`, asked by
 *    `unzipFile` before it reads a byte of it. Throwing refuses the
 *    extraction with what was thrown: nothing is written and no entry is
 *    named. (`apply_file_upload` lands the caller's own upload, which is no
 *    file of the knowledge base, and does not ask it.)
 *  - `destination`: may the caller change the folder at `wsPath` the archive
 *    extracts into, asked by `unzipFile` before the folder is probed.
 *    Throwing refuses the extraction as `archive` does. (`apply_file_upload`
 *    asks its destination its own way.)
 *
 * Then one judge answers three questions about an entry:
 *
 *  - `entry`: may it be landed at all, asked before anything is locked or
 *    written. Throwing skips the entry with the thrown message; throwing
 *    `ArchiveRefusedError` refuses the whole archive.
 *  - `refusedAtLock`: taking the entry's lock threw — the lock's own gates
 *    refused it, or the lock service failed — with nothing written yet.
 *    Returning skips the entry with `err`'s message; throwing refuses the
 *    whole archive with what was thrown.
 *  - `skipped`: what an entry that will not land, for any reason, means for
 *    the archive: the whole-archive refusal to raise, or null when only the
 *    entry is skipped. (An extraction drops macOS metadata entries without
 *    asking.) `wsPath` is where the entry would land, or null when
 *    its name gives it no place.
 */
export interface ArchiveEntryJudge {
  archive(wsPath: string): Promise<void>;
  destination(wsPath: string): Promise<void>;
  entry(wsPath: string, kind: 'file' | 'dir'): Promise<void>;
  refusedAtLock(wsPath: string, err: unknown): void;
  skipped(wsPath: string | null, entryName: string, why: unknown): ArchiveRefusedError | null;
}

/**
 * The 409 an extraction answers when another holds a lock its landing needs.
 * It carries `PathHeldError`'s payload, `{ kind: 'path-held', path }`, as the
 * write tools that pass that error on do; its sentence is the extraction's
 * own, saying nothing was extracted.
 */
function extractionHeldRefusal(err: PathHeldError): VersionControlDomainError {
  return new VersionControlDomainError(
    err.lapsed
      ? `The extraction could not confirm it still held the lock on "${err.path}", so nothing was extracted. Try again.`
      : `"${err.path}" is being edited by ${err.holderName ?? 'another user'}, so nothing was extracted. Try again once they are done.`,
    409,
    { kind: 'path-held', path: err.path },
  );
}

// What one archive may land as one commit: an extraction (`unzipFile`) and an
// apply (`apply_file_upload`) both hold every entry's bytes in memory until
// that commit, so the property that makes the landing atomic is the one that
// makes a zip bomb expensive. These bound what one archive may expand into;
// an entry past them is skipped with the reason, and nothing else changes.
export const ONE_COMMIT_MAX_ENTRIES = 5_000;
export const ONE_COMMIT_MAX_TOTAL_BYTES = 128 * 1024 * 1024; // 128 MB uncompressed
/** The caps above and the one on a single file, as both surfaces hand them to `planZipEntries`. */
export const ONE_COMMIT_LIMITS: ZipPlanLimits = {
  entries: ONE_COMMIT_MAX_ENTRIES,
  totalBytes: ONE_COMMIT_MAX_TOTAL_BYTES,
  entryBytes: 100 * 1024 * 1024, // 100 MB per file
};

/** The refusal `unzipFile` reports for an entry whose target meets a link or the git folder. */
function obstacleRefusal(obstacle: LandingObstacle): Error {
  return obstacle.kind === 'link' ? new PathTraversalError() : new GitInternalsError();
}

/** What `unzipFile` reports, as `skipped[].reason`, for an entry the planner skipped. */
function unzipSkipReason(step: ZipPlanSkip): string {
  switch (step.reason) {
    case 'too_many_entries':
      return `Archive exceeds ${ONE_COMMIT_LIMITS.entries} entries`;
    case 'invalid_name':
      return step.detail;
    case 'escapes_destination':
      return 'Path escapes destination';
    case 'link':
      return 'Entry is a symbolic link, not a file';
    case 'directory_is_a_file':
      return 'Directory entry is at the path of a file in the same archive';
    case 'entry_too_large':
      return `Entry exceeds ${ONE_COMMIT_LIMITS.entryBytes} byte per-file limit`;
    case 'total_too_large':
      return `Archive exceeds ${ONE_COMMIT_LIMITS.totalBytes} byte total uncompressed limit`;
    case 'unreadable':
      return `Entry could not be read: ${step.detail}`;
  }
}

// Folder-download cap. The whole zip is built in memory by adm-zip (no
// streaming) so the cap also bounds peak heap usage for one download.
export const ZIP_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;

// How many files one agent download request may carry: a bound on the lists a
// request builds before anything is judged.
export const DOWNLOAD_MAX_FILES = 10_000;

/**
 * Which of a folder's files a zip may pack: handed every file the walk found
 * (repository-relative, POSIX separators), answers the set to include. The
 * route builds one from the caller's `read` and `download` verdicts — see
 * `createFolderZip` for why it is required.
 */
export type ZipEntryFilter = (repoRelativePaths: string[]) => Promise<ReadonlySet<string>>;

/**
 * Thrown by `createFolderZip` when the cumulative uncompressed bytes exceed
 * `ZIP_DOWNLOAD_MAX_BYTES`. Carries a 413-ready message; the route layer
 * checks `instanceof` and maps it accordingly.
 */
export class FolderTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`Folder exceeds the ${limitBytes}-byte download size limit`);
    this.name = 'FolderTooLargeError';
  }
}

/**
 * A rename or move would land on a name something else already has. 409, like
 * every other precondition the caller has to clear first: nothing was moved,
 * and the entry already there is untouched.
 *
 * Lives here rather than in `shared/domain-errors.ts` because the sentence is
 * built by `entryExistsMessage` and that file deliberately imports no VALUE
 * from `@bevel-software/platform-shared`, only a type. It still extends
 * `VersionControlDomainError`, so the routes' `sendError` maps it to 409 with
 * `{ kind: 'entry-exists', … }` without knowing this class exists.
 */
export class EntryExistsError extends VersionControlDomainError {
  readonly kind = 'entry-exists' as const;
  constructor(readonly entryKind: ExistingEntryKind, readonly destination: string) {
    super(entryExistsMessage(entryKind, destination), 409, {
      kind: 'entry-exists',
      entryKind,
      destination,
    });
    this.name = 'EntryExistsError';
  }
}

/** Redact the token the runner authenticates with from an error message. */
function redactError(err: unknown, token: string | null): string {
  const msg = err instanceof Error ? err.message : String(err);
  return token ? msg.replaceAll(token, '***') : msg;
}

const FETCH_CACHE_TTL_MS = 30_000;

/**
 * The bytes a conditional write compares against. An absent file reads as the
 * empty string, so `expectedContent: ''` means "expect nothing there yet".
 *
 * A directory at the path is a client error, not a 500 with a raw OS message:
 * `GET /file` counts EISDIR as "no file at this path", so the editor that
 * opened empty on that 404 would otherwise be told its save failed for an
 * unexplained internal reason. Anything else (EACCES, EIO) is a real read
 * failure and propagates: an unreadable file must not pass for an empty one.
 */
async function readForConditionalWrite(absolutePath: string, relativePath: string): Promise<string> {
  try {
    return await fs.readFile(absolutePath, 'utf-8');
  } catch (err) {
    if (isAbsence(err)) return '';
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EISDIR') {
      const notAFile: Error & { status?: number } = new Error(
        `"${relativePath}" is a directory, not a file.`,
      );
      notAFile.status = 400;
      throw notAFile;
    }
    throw err;
  }
}

/**
 * The published library's path rule, refused as a TYPED 400.
 *
 * The library throws a bare `Error('Invalid path: …')` — it is shared with
 * the frontend and cannot carry a backend domain type — and the routes used
 * to recognise that by its message prefix. Converting it here, at the one
 * layer that calls it, is what lets the route layer read a status off a
 * class like it does for every other refusal.
 */
function assertValidPath(relativePath: string): void {
  const reason = validateRelativePath(relativePath);
  if (reason) throw new VersionControlValidationError(`Invalid path: ${reason}`);
}

/** Throw the conditional write's 409 unless the file still holds `expectedContent`. */
async function assertConditionalWriteMatches(
  absolutePath: string,
  relativePath: string,
  expectedContent: string,
): Promise<void> {
  const current = await readForConditionalWrite(absolutePath, relativePath);
  if (current === expectedContent) return;
  const stale: Error & { status?: number } = new Error(
    `"${relativePath}" changed since you opened it. Reload it and apply your edit again, ` +
      'so the other change is not overwritten.',
  );
  stale.status = 409;
  throw stale;
}

/**
 * Per-directory read filter for the file tree. Given a batch of
 * workspace-relative entry paths (e.g. `staging-repo/Product/Knowledge/x.md`),
 * returns a verdict map keyed by those paths (`path → readable`). Injected by
 * the route from the access service so `WorkspaceService` stays access-agnostic
 * (it gets a function, not the access module). See `modules/access-model/kb-read-filter.ts`.
 */
export type ReadTreeFilter = (wsRelPaths: string[]) => Promise<Map<string, boolean>>;

export class WorkspaceService implements IWorkspaceService {
  /** Maps branch → absolute directory path. Lazily populated. */
  private readonly branchDirs = new Map<string, string>();

  /**
   * In-flight bootstrap promises keyed by branch — concurrent callers for
   * the same branch share a single clone instead of racing to overwrite
   * each other's working tree.
   */
  private readonly inFlightBootstraps = new Map<string, Promise<void>>();

  /** Per-workspace-dir `git fetch origin` timestamp + in-flight tracker. */
  private readonly lastFetchAt = new Map<string, number>();
  /** Whether the last fetch per repo SUCCEEDED — read by strict callers of `ensureRemotesFetched`. */
  private readonly lastFetchOk = new Map<string, boolean>();
  private readonly inFlightFetches = new Map<string, Promise<void>>();
  /**
   * One mutation at a time per file, keyed by RESOLVED absolute path — so
   * `x/a.md`, `./x/a.md` and `x//a.md` are one queue and not three. See
   * {@link withPathTurn} for what takes a turn and why.
   */
  private readonly writeTurns = new Map<string, Promise<void>>();
  /**
   * The folder structure changes in flight, keyed by RESOLVED absolute folder
   * path — see {@link withFolderTurn}.
   */
  private readonly folderTurns = new Map<string, Promise<void>>();
  /**
   * The turns the CURRENT async context already holds. Taking one it holds
   * runs straight through instead of waiting for itself, which is what lets a
   * caller wrap a whole read-decide-write sequence in a turn and still call
   * the ordinary write inside it.
   */
  /**
   * The turns the current async context holds, each with the tail of the
   * nested mutations already launched inside it — so a re-entrant call never
   * waits for the outer turn (that would hang) while two nested calls on the
   * same path, launched side by side inside one turn, still run one at a
   * time. The map is inherited by every child context; the entry object is
   * shared, which is what makes siblings queue on one tail.
   */
  private readonly heldTurns = new AsyncLocalStorage<ReadonlyMap<string, HeldTurn>>();

  /**
   * Late-bound by the composition root — DiffService depends on
   * WorkspaceService for path resolution.
   */
  private diffService: IDiffService | null = null;

  /**
   * Late-bound by the composition root: notified with the workspace id
   * right after a branch's clone is created. The git layer uses this to
   * skip the otherwise-redundant implicit `git fetch` on the first
   * `listBranches` — a fresh clone has already downloaded every ref.
   */
  private onWorkspaceCloned: ((workspaceId: string) => void) | null = null;

  constructor(
    private readonly workspacesRoot: string,
    /**
     * The KB remote. A GETTER is read per-clone, so a repository supplied
     * through the setup screen takes effect without restarting the process; a
     * plain string is still accepted for callers that have nothing to vary.
     *
     * `kbDirName` stays a plain string on purpose — it is threaded into a
     * dozen other services at construction, so making it live only here would
     * buy an inconsistency rather than a feature.
     */
    kbRepoUrl: string | (() => string),
    /** The checkout folder's name, and which branch a caller lands on when naming none. */
    private readonly kb: Pick<KbContext, 'kbDirName' | 'defaultBranch'>,
    private readonly disk: ITreeWalker,
    /**
     * How git is run — see `shared/git.contract.ts`. The composition root
     * passes the one runner carrying the deployment's deadline and the
     * credentials every clone authenticates with; the default is the same
     * runner on its default deadline and no token, for a directly
     * constructed service.
     */
    private readonly gitRunner: IGitRunner = new NodeGitRunner(),
    /**
     * Where a working copy of a repository that is no longer the configured
     * one is kept. THE SAME VALUE THE KB STARTUP PHASE IS GIVEN — what the two
     * of them move must end up in one place, and omitting it here falls back to
     * a directory that does not survive a deployment's next recreate.
     *
     * Why, in one place: `setAsideRootFor` in `set-aside-clone.ts`.
     */
    private readonly setAsideRoot: string | undefined,
    /**
     * What surrounds the setting aside of ONE working copy when a branch is
     * opened and its clone turns out to be of another repository: given the
     * workspace id and the move, it runs the move. The composition root
     * passes what the startup phase does around its own set-asides: the
     * commit worker held still, the copy's queued commits held back for a
     * person, the locks on its branch dropped. If it throws, the copy stays
     * where it was and the branch is refused with that reason. Absent, the
     * move runs as it is.
     */
    private readonly aroundSetAside: (workspaceId: string, move: () => Promise<void>) => Promise<void> = (
      _workspaceId,
      move,
    ) => move(),
    /**
     * The one repository every branch workspace is a worktree of — THE SAME
     * INSTANCE THE KB STARTUP PHASE AND THE GIT LAYER USE, so that one fetch
     * serves them all and its reservation is one. Built by the composition
     * root, never here.
     */
    readonly repository: IKbRepository,
  ) {
    this.kbRepoUrl = typeof kbRepoUrl === 'function' ? kbRepoUrl : () => kbRepoUrl;
  }

  /**
   * Whether the checkout folder `repoDir` is a worktree (its `.git` a file)
   * rather than a full clone. A stat, no git.
   */
  private async isWorktree(repoDir: string): Promise<boolean> {
    // Synchronous on purpose: it is one stat of a local file, and it sits in
    // front of the fetch joins (`ensureRemotesFetched`), where an await
    // between two concurrent callers' in-flight checks is what lets both
    // start a fetch.
    try {
      return statSync(path.join(repoDir, '.git')).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Whether `repoDir` holds a working copy that can be served: a worktree of
   * the repository or a full clone. A worktree whose link to the repository is
   * broken is NOT one — it is an unfinished checkout, recreated on the next
   * open. Errors other than absence propagate.
   */
  private async hasWorkingCopy(repoDir: string): Promise<boolean> {
    const shape = await workingCopyShape(repoDir);
    return shape === 'worktree' || shape === 'clone';
  }

  /**
   * The repository behind a workspace when it is a worktree of it; null for a
   * full clone (which fetches on its own) or a workspace with no checkout.
   * For the git layer, which keys its fetches on this.
   */
  async sharedRepositoryOf(workspaceId: string): Promise<IKbRepository | null> {
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    return this.repositoryOfCheckout(path.join(workspaceDir, this.kbDirName));
  }

  /** {@link sharedRepositoryOf}, for a caller that already has the checkout folder. */
  async repositoryOfCheckout(repoDir: string): Promise<IKbRepository | null> {
    return (await this.isWorktree(repoDir)) ? this.repository : null;
  }

  /**
   * The set-asides in flight, one per branch. Two callers opening the same
   * branch both find the clone of another repository; the second waits for
   * the first's move instead of trying to move a directory that has gone.
   */
  private readonly inFlightSetAsides = new Map<string, Promise<void>>();

  private get kbDirName(): string {
    return this.kb.kbDirName;
  }

  private readonly kbRepoUrl: () => string;

  setDiffService(diffService: IDiffService): void {
    this.diffService = diffService;
  }

  setWorkspaceClonedListener(listener: (workspaceId: string) => void): void {
    this.onWorkspaceCloned = listener;
  }

  /**
   * Every branch name this process has been shown to be real: named by a
   * listing of origin's branches, or registered as a clone of ours. Together
   * with the clones still on disk this is the whole of what the platform
   * KNOWS about branch names — and the difference between "your link is to a
   * branch that was deleted" (410) and "there is no branch by that name"
   * (404).
   *
   * Names ACCUMULATE and are never removed, and the two halves of that are
   * the same rule: the evidence we need is evidence about a branch that is
   * no longer there. Replacing the set on each listing would forget a
   * deleted branch at the moment its deletion becomes the thing we have to
   * report; evicting an old name would silently turn a long-dead branch back
   * into "never existed"; dropping a clone's name when its workspace is swept
   * would do that to a branch we cloned ourselves. So nothing here is ever
   * dropped. Growth is one short string per distinct branch name origin has
   * ever shown this process — kilobytes for any real repository, and reset
   * by a restart.
   *
   * In memory only, by the spec's decision — no new persistence. A restart
   * forgets a deleted branch whose clone was already retired, and that name
   * then reads as unknown, which is exactly what the platform then knows.
   */
  private readonly branchesEverHeardOf = new Set<string>();

  /**
   * Record the branch names a listing returned. Called by the git layer after
   * every `listBranches` (wired in the composition root), which is the one
   * place the platform ever sees origin's set of branches.
   */
  noteBranchesListed(names: readonly string[]): void {
    for (const name of names) this.branchesEverHeardOf.add(name);
  }

  /**
   * Register a branch's clone directory — the only writer of `branchDirs`, so
   * that every clone this process opens (fresh, adopted off disk, or handed
   * over by a concurrent bootstrap) also leaves its branch name in
   * `branchesEverHeardOf`. `branchDirs` is a cache of live clones and loses the
   * branch when its workspace is swept; the name left behind is the record
   * that the branch was real, and outlives the clone.
   */
  private registerBranchDir(branch: string, workspaceDir: string): void {
    this.branchDirs.set(branch, workspaceDir);
    this.branchesEverHeardOf.add(branch);
  }

  /**
   * Has the platform ever heard of this branch? A clone of it — registered in
   * this process, remembered from one, or sitting on disk from a previous one
   * — or a listing that named it. Only asked on the failure path, where
   * origin has just answered that it has no such ref: a yes means the branch
   * was deleted (410), a no means it never existed as far as the platform is
   * concerned (404).
   */
  private async hasHeardOfBranch(branch: string): Promise<boolean> {
    if (this.branchDirs.has(branch)) return true;
    if (this.branchesEverHeardOf.has(branch)) return true;
    try {
      await fs.access(path.join(this.workspacesRoot, workspaceIdForBranch(branch), this.kbDirName, '.git'));
      return true;
    } catch (err) {
      // Only "there is nothing there" answers the question. A permission or
      // I/O fault means we could not look, and a storage failure of ours must
      // not be reported to the caller as a branch that never existed: it
      // stays the 500 the operator reads.
      if (isAbsence(err)) return false;
      throw err;
    }
  }

  /**
   * Does `branch` certainly not exist? Asked by the tool handler before a tool
   * runs, so a call naming a branch nobody ever pushed is answered 404 without
   * a workspace being created for it.
   *
   * Never clones and never creates a directory. A branch this platform has a
   * clone of, is cloning, or has ever heard of is NOT missing: one that origin
   * has since deleted is left to the open, which answers its 410. Anything
   * else is asked of origin with `ls-remote`, and only origin's "no such ref"
   * makes it missing. A name that is malformed, or a remote that could not be
   * asked, is `false` too: the open then answers for it, exactly as before.
   * A storage fault reading what this platform has heard of is NOT read as
   * either answer: it propagates, the 500 the operator reads.
   */
  async isBranchMissing(branch: string): Promise<boolean> {
    try {
      assertValidBranchName(branch);
    } catch {
      return false;
    }
    if (this.branchDirs.has(branch) || this.inFlightBootstraps.has(branch)) return false;
    if (await this.hasHeardOfBranch(branch)) return false;
    const helper = credentialHelperValue(this.gitRunner.credentials);
    try {
      const { stdout } = await this.gitRunner.run(this.workspacesRoot, [
        ...(helper ? ['-c', `credential.helper=${helper}`] : []),
        'ls-remote',
        '--exit-code',
        '--heads',
        '--end-of-options',
        this.kbRepoUrl(),
        `refs/heads/${branch}`,
      ]);
      // The argument is a PATTERN, matched at any slash boundary: it also
      // lists `refs/heads/refs/heads/<branch>`. Only the exact ref counts.
      const ref = `refs/heads/${branch}`;
      return !stdout.split('\n').some((line) => line.split('\t')[1]?.trim() === ref);
    } catch (err) {
      // `--exit-code`: 2 is "the remote answered, and has no matching ref".
      // Every other failure is a remote we could not ask.
      return err instanceof GitRunError && err.exitCode === 2;
    }
  }

  /**
   * Return the id of any workspace already cloned on disk, or null if none
   * exists. Every clone tracks the same origin, so for a *repo-global* operation
   * that doesn't act on a particular draft — listing branches, reading or
   * merging a change request by number — any existing clone is interchangeable.
   * Reusing one that's already on disk avoids cloning a branch (or failing when
   * a conventional default branch isn't on the remote) just to run a global op.
   * Scans disk rather than the in-memory `branchDirs` map so clones that
   * survived a process restart are still found.
   *
   * INTERCHANGEABLE ONLY ONCE IT CAN REACH THE REMOTE. The clone handed back
   * is one this process may never have opened, and opening a branch is the
   * only other place a clone's credential helper is brought into line with the
   * deployment's (`getOrCreateForBranch`). A clone made before the helper was
   * persisted, or before a token was configured, has none — and it is exactly
   * the kind that sorts first on disk, because it is old. Every repo-global
   * operation then ran its fetches in a working copy that could not
   * authenticate: the fetch failed, quietly, and each change request whose
   * branch that clone had never seen was reported as `unknown branch`, list
   * after list, while the branches sat on the remote. So the helper is stamped
   * here too, before the clone is offered. A no-op for a clone already stamped
   * in this process, and it never throws (see `stampCredentialHelper`).
   */
  async findAnyWorkspaceId(): Promise<string | null> {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(this.workspacesRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const repoDir = path.join(this.workspacesRoot, entry.name, this.kbDirName);
      // No working copy — half-built, a worktree whose repository is gone, or
      // an unrelated dir; keep looking.
      if (!(await this.hasWorkingCopy(repoDir).catch(() => false))) continue;
      await this.refreshCredentialHelperIfStale(branchForWorkspaceId(entry.name), repoDir);
      return entry.name;
    }
    return null;
  }

  /**
   * Every branch with a finished clone on disk, whether or not this process
   * has touched it yet. The remote sync reads this: clones survive a restart,
   * and a hook that fires before anyone opens a branch must still find its
   * clone. Same disk scan as `findAnyWorkspaceId`.
   *
   * What is listed: directories holding a `<kbDirName>/.git`, whose name is
   * the encoding of a branch git would accept, and whose bootstrap is not in
   * flight right now. The in-flight exclusion matters because `git clone`
   * creates `.git` long before the working tree is checked out — pulling a
   * clone mid-bootstrap would run git against a half-written tree — and a
   * clone that is being created this instant is current by definition. A
   * clone left behind by a crash mid-checkout is NOT distinguished here: the
   * rest of this service treats a directory with `.git` as a clone too, and
   * the pull's own errors are how such a tree surfaces.
   *
   * A missing root means no clones (nothing has been bootstrapped yet); any
   * other failure to read it is propagated, so a sync cannot report success
   * over a root it could not see. One entry that cannot be probed (an ACL, a
   * half-deleted directory) is returned with `unreadable` set rather than
   * thrown, so it fails as one branch and not as the whole listing.
   */
  async listClonedWorkspaces(): Promise<Array<{ id: string; branch: string; unreadable?: string }>> {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(this.workspacesRoot, { withFileTypes: true });
    } catch (err) {
      if (isAbsence(err)) return [];
      throw err;
    }
    const cloned: Array<{ id: string; branch: string; unreadable?: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const branch = branchForWorkspaceId(entry.name);
      // Not one of ours unless the name is the encoding of a branch git
      // accepts: `branchForWorkspaceId` returns a malformed name unchanged, so
      // the round-trip catches those, and the validator catches a stray
      // directory whose name merely round-trips.
      if (workspaceIdForBranch(branch) !== entry.name) continue;
      try {
        assertValidBranchName(branch);
      } catch {
        continue;
      }
      try {
        // A worktree whose repository is gone is not a working copy to pull:
        // it is recreated when the branch is next opened.
        if (!(await this.hasWorkingCopy(path.join(this.workspacesRoot, entry.name, this.kbDirName)))) continue;
      } catch (err) {
        if (isAbsence(err)) continue;
        cloned.push({
          id: entry.name,
          branch,
          unreadable: `Could not read this branch's clone: ${redactError(err, this.gitRunner.credentials.token())}`,
        });
        continue;
      }
      // AFTER the probe, with no await in between: a bootstrap registers
      // itself before it creates `.git`, so any clone whose `.git` was found
      // while its bootstrap is running is in this map by now. Checking before
      // the probe left a window where the clone started in between.
      if (this.isBootstrapInFlight(branch)) continue;
      cloned.push({ id: entry.name, branch });
    }
    return cloned;
  }

  /**
   * Get-or-create the per-branch workspace. Idempotent — repeat calls for
   * the same branch reuse the existing clone. Concurrent first-callers
   * share one bootstrap via `inFlightBootstraps`.
   */
  async getOrCreateForBranch(branch: string): Promise<WorkspaceInfo> {
    assertValidBranchName(branch);
    const id = workspaceIdForBranch(branch);
    const workspaceDir = path.join(this.workspacesRoot, id);
    const repoDir = path.join(workspaceDir, this.kbDirName);

    // Fast path: we've already bootstrapped this branch in this process.
    // Wait for any in-flight bootstrap before returning so we never hand
    // back a half-cloned workspace.
    if (this.branchDirs.has(branch)) {
      await this.awaitBootstrapOrEvict(branch);
      // A token or username set/changed through the setup screen after this
      // branch was first opened has to reach the already-cached clone, or its
      // pushes keep failing — the fast path is exactly where that rotation is
      // otherwise missed.
      await this.refreshCredentialHelperIfStale(branch, repoDir);
      return this.buildWorkspaceInfo(branch, workspaceDir);
    }

    // If a bootstrap is in flight for this branch, wait it out before
    // trusting the on-disk check below. `git clone` creates `.git` within
    // the first few hundred ms of a multi-second clone, well before the
    // working tree (roles.yaml, access.md, every tracked file) is checked
    // out — so a naive fs.access(.git) on a mid-clone dir happily hands a
    // half-cloned workspace to the caller, and the next loadModel /
    // readFile faceplants with ENOENT and 500s. This mirrors the
    // single-flight wait the cached fast path already uses.
    await this.awaitBootstrapOrEvict(branch);
    if (this.branchDirs.has(branch)) {
      await this.refreshCredentialHelperIfStale(branch, repoDir);
      return this.buildWorkspaceInfo(branch, workspaceDir);
    }

    // Check disk — the worktree (or a clone from an earlier release) may have
    // been made by a previous process and survived a restart. A worktree whose
    // repository is gone is not on disk in any useful sense: bootstrap below
    // recreates it.
    const onDisk = await this.hasWorkingCopy(repoDir).catch(() => false);
    // A clone fetches and pushes through the address stored in its OWN
    // `remote.origin.url`, which nothing rewrites when the configured
    // repository changes. Adopting one of the repository that was replaced is
    // how every later fetch answers "repository not found" — so it is set
    // aside here and cloned fresh below, the same rule, and the same
    // destination, as the KB startup phase applies to the whole workspaces
    // root.
    //
    // SET ASIDE, never deleted. The phase sweeps only AFTER it has reached the
    // configured remote, so that a typo in the address cannot cost anyone
    // their work. This path has reached nothing: it is a branch being opened,
    // and it runs in exactly the states where the address is stored but
    // unproven — a gated boot, a break-glass start, a save that changed the
    // address before the phase got to it. Deleting on a string difference
    // there would throw away commits that exist nowhere else because somebody
    // mistyped a host name.
    //
    // OUTSIDE the adoption `try` below, deliberately: a clone that cannot be
    // moved must fail this call with that reason. Swallowed into "bootstrap
    // below", it would be found again by the clone step, which sees a
    // directory with a `.git` in it, calls that already-cloned, and hands back
    // the very working copy this refused to adopt.
    // Counted before the disk is looked at: the startup phase may take this
    // very copy away while the checks below are awaited (`forgetClone`), and a
    // copy that went must not be registered as the branch's.
    const discardsAtAdoption = this.discardsOf(id);
    const setAsideInFlight = this.inFlightSetAsides.get(branch);
    if (setAsideInFlight) {
      // Someone else is moving it. Wait, then clone below; a move that failed
      // refuses this caller with the same reason.
      await setAsideInFlight;
    } else if (
      onDisk
        ? await this.isCloneOfAnotherRepository(repoDir)
        : // Nothing of this branch on disk yet, but the worktree it is about to
          // get would be of the one repository — whose address may be the
          // replaced one, until the startup phase has been through.
          await this.isRepositoryOfAnother()
    ) {
      // Asked again: another caller may have started the move while the
      // address was being read.
      const startedMeanwhile = this.inFlightSetAsides.get(branch);
      if (startedMeanwhile) {
        await startedMeanwhile;
      } else if (this.discardsOf(id) !== discardsAtAdoption) {
        // The copy whose address this call read is no longer there: a move
        // began AND ended while it was being read. An in-flight entry is
        // cleared the moment its move ends, so a caller that comes back after
        // that finds nobody to wait for — and its answer is about a copy that
        // has already been set aside. Acting on it would set aside whatever is
        // at this path NOW, which is the fresh clone the first caller is in
        // the middle of making. Nothing is left to move; the bootstrap below
        // waits for that clone.
      } else if (!onDisk || (await this.isWorktree(repoDir))) {
        // A worktree of a repository of another address: the address is the
        // REPOSITORY's, and its commits are the repository's, so the repository
        // and every worktree of it are set aside together, into one folder.
        const kept = path.join(setAsideRootFor(this.workspacesRoot, this.setAsideRoot), setAsideStamp());
        const ids = await this.worktreeIdsOnDisk();
        if (onDisk && !ids.includes(id)) ids.push(id);
        let movedIds: string[] | null = null;
        const move = async (): Promise<void> => {
          if (this.discardsOf(id) !== discardsAtAdoption) return;
          // Asked again under the reservation: two branches opened at once
          // both read the old address, and the first one's set-aside and fresh
          // repository may be done by the time this one holds it. Moving then
          // would set aside the replacement and the first branch's worktree.
          let superseded = false;
          const ids = await setAsideRepository(this.repository, this.workspacesRoot, this.kbDirName, kept, async () => {
            superseded = !(await this.isRepositoryOfAnother());
            return !superseded;
          });
          if (superseded) return;
          movedIds = ids;
          for (const movedId of movedIds) this.forgetClone(movedId);
        };
        // What surrounds a set-aside is asked for every workspace that goes,
        // nested, so the move runs once with all of them held.
        const wrapped = ids.reduce<() => Promise<void>>((inner, wid) => () => this.aroundSetAside(wid, inner), move);
        const moving = this.settleSetAside(wrapped(), () => movedIds !== null, branch).finally(() => {
          this.inFlightSetAsides.delete(branch);
        });
        this.inFlightSetAsides.set(branch, moving);
        await moving;
        if (movedIds) {
          log.warn(
            `the knowledge-base repository and its ${(movedIds as string[]).length} worktree(s) were of another ` +
              `repository. Set aside together at ${kept}; nothing was deleted, and "${branch}" is being opened ` +
              'fresh from the configured one. Work that was never pushed is in that folder.',
          );
        }
      } else {
        const kept = path.join(setAsideRootFor(this.workspacesRoot, this.setAsideRoot), setAsideStamp(), id);
        // What surrounds the move may wait, and the startup phase may set
        // this very copy aside meanwhile. Then there is nothing left to move:
        // the phase did it, and said so.
        let moved = false;
        const move = async (): Promise<void> => {
          if (this.discardsOf(id) !== discardsAtAdoption) return;
          await setAsideClone(repoDir, kept);
          moved = true;
          // Said the way the startup phase says it: the copy at this path was
          // taken away. That is what the check above reads, so every caller
          // that looked at the old copy before this line knows its answer is
          // stale, however late it comes back.
          this.forgetClone(id);
        };
        const moving = this.settleSetAside(this.aroundSetAside(id, move), () => moved, branch).finally(() => {
          this.inFlightSetAsides.delete(branch);
        });
        this.inFlightSetAsides.set(branch, moving);
        await moving;
        if (moved) {
          log.warn(
            `the "${branch}" working copy was a clone of another repository. Set aside at ${kept}; nothing was ` +
              'deleted, and it is being cloned fresh from the configured one. Work that was never pushed is in ' +
              'that folder: `git log` there shows it.',
          );
        }
      }
    } else if (onDisk) {
      try {
        // Migration for clones already on disk: re-stamp the tracking config
        // the first time this process opens them, so a clone whose config
        // drifted (duplicate fetch refspec / merge ref) is repaired before
        // anything pulls it. Once per branch per process — the cached paths
        // above return before reaching here.
        await this.normalizeCloneConfig(repoDir, branch);
        // Taken away meanwhile: nothing to adopt, clone below.
        if (this.discardsOf(id) !== discardsAtAdoption) throw new Error('the working copy was set aside');
        this.registerBranchDir(branch, workspaceDir);
        return this.buildWorkspaceInfo(branch, workspaceDir);
      } catch {
        // No longer worth adopting — bootstrap below.
      }
    }

    // Single-flight bootstrap. Concurrent callers for the same branch
    // share the first one's promise instead of stacking clones.
    //
    // Recorded before any of it: a clone takes seconds, and the save that
    // replaces the repository can land in the middle of one. Whatever this
    // bootstrap produces is about the repository configured NOW, so if the
    // working copy is taken away while it runs (`forgetClone`) the result must
    // not be published — see `adoptBootstrapped`.
    const discardsAtBootstrap = this.discardsOf(workspaceIdForBranch(branch));
    let resolveBootstrap!: () => void;
    let rejectBootstrap!: (err: unknown) => void;
    const bootstrap = new Promise<void>((res, rej) => {
      resolveBootstrap = res;
      rejectBootstrap = rej;
    });
    bootstrap.catch(() => undefined);

    const existingBootstrap = this.inFlightBootstraps.get(branch);
    if (existingBootstrap) {
      await existingBootstrap;
      this.adoptBootstrapped(branch, workspaceDir, discardsAtBootstrap);
      return this.buildWorkspaceInfo(branch, workspaceDir);
    }
    this.inFlightBootstraps.set(branch, bootstrap);

    // `mkdir --recursive` answers with the first path it CREATED, or undefined
    // when the directory was already there. That is the only honest signal for
    // what the rollback below may remove: a directory this attempt made is ours
    // to take back, one that predates us belongs to whatever put it there.
    let createdWorkspaceDir: string | undefined;
    try {
      // A clone with `-b <branch>` against a never-seeded remote fails
      // naturally; seeding the remote is the KB startup phase's job, at boot.
      createdWorkspaceDir = await fs.mkdir(workspaceDir, { recursive: true });
      await this.cloneProcessMapForBranch(workspaceDir, branch);
      this.adoptBootstrapped(branch, workspaceDir, discardsAtBootstrap);
      resolveBootstrap();
    } catch (err) {
      this.branchDirs.delete(branch);
      // A bootstrap that failed leaves NOTHING behind. The clone rolls its own
      // target back, but the workspace directory around it would survive as an
      // empty shell named after the branch — and a directory named after a
      // branch is read as the platform having known that branch: by
      // `hasHeardOfBranch`, which would turn the next attempt's honest 404 into
      // "no longer exists on the remote" (410), and by anyone reading the
      // workspaces root. Best-effort: a rollback that cannot delete must not
      // replace the real failure (the clone's) with its own.
      if (createdWorkspaceDir !== undefined) {
        await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
      }
      rejectBootstrap(err);
      throw err;
    } finally {
      if (this.inFlightBootstraps.get(branch) === bootstrap) {
        this.inFlightBootstraps.delete(branch);
      }
    }

    return this.buildWorkspaceInfo(branch, workspaceDir);
  }

  /**
   * Convenience: open-or-create the workspace using the caller's user
   * record only for typing / auditing context. Used by route handlers
   * that don't know the target branch up-front (e.g. legacy bootstrap
   * paths). Always resolves to the default protected branch unless
   * `branch` is passed.
   */
  async getOrCreateForUser(_user: AuthUser, branch?: string): Promise<WorkspaceInfo> {
    return this.getOrCreateForBranch(branch ?? this.kb.defaultBranch);
  }

  private buildWorkspaceInfo(branch: string, workspaceDir: string): WorkspaceInfo {
    return {
      id: workspaceIdForBranch(branch),
      name: `${branch}`,
      absolutePath: workspaceDir,
      createdAt: new Date(0).toISOString(),
      kbDirName: this.kbDirName,
    };
  }

  /**
   * Publish a finished bootstrap's working copy to the branch→directory cache
   * — unless the copy was taken out from under it while it ran.
   *
   * The save that replaces the knowledge-base repository sets every working
   * copy aside and clears this cache (`forgetClone`), and a clone takes
   * seconds: a bootstrap already in flight when that happens finishes
   * afterwards, and a plain `registerBranchDir` would put the path back. The
   * directory is gone (set aside), so every reader from then on gets an
   * ENOENT off the fast path and nothing ever re-clones it — a cache entry
   * is exactly what stops that.
   *
   * Refused rather than retried here: the address this bootstrap cloned from
   * is not the one configured now, so there is nothing to salvage. The caller
   * is told, and opening the branch again clones it from the new address.
   */
  private adoptBootstrapped(branch: string, workspaceDir: string, discardsAtStart: number): void {
    if (this.discardsOf(workspaceIdForBranch(branch)) !== discardsAtStart) {
      this.branchDirs.delete(branch);
      throw new Error(
        `The knowledge-base repository was replaced while the "${branch}" working copy was being created, so ` +
          'that copy was set aside instead of being used. Open it again to get one of the new repository.',
      );
    }
    this.registerBranchDir(branch, workspaceDir);
  }

  /**
   * Await the in-flight bootstrap for a branch (if any). On reject —
   * meaning the clone rolled back — drop the branch→dir mapping so the
   * next caller re-bootstraps.
   */
  private async awaitBootstrapOrEvict(branch: string): Promise<void> {
    const pending = this.inFlightBootstraps.get(branch);
    if (!pending) return;
    try {
      await pending;
    } catch (err) {
      this.branchDirs.delete(branch);
      throw err;
    }
  }

  /**
   * Whether a clone of `branch` is being created at this moment. Read by the
   * retirement of a clone the host deleted: a bootstrap in flight means the
   * branch exists again, so there is nothing stale to remove.
   */
  isBootstrapInFlight(branch: string): boolean {
    return this.inFlightBootstraps.has(branch);
  }

  /**
   * Whether the clone at `repoDir` belongs to a repository OTHER than the
   * configured one.
   *
   * Errs towards NO — "could not tell" must never delete someone's work:
   * an address that cannot be read (no `origin`, a git that would not run)
   * leaves the clone alone, and only two addresses that are read and differ
   * in more than their spelling count as different repositories (see
   * `kb-fs/remote-url.ts`). An UNCONFIGURED address answers no as well: a
   * process that does not know where the repository is has no business
   * declaring a clone stale.
   */
  /**
   * Wait for a set-aside. Its failure refuses the branch only while nothing
   * has moved: once the move happened, what failed is what runs AFTER it
   * around the move (`aroundSetAside` looking for the copy's work again,
   * which already retries itself), and refusing then would report a move that
   * did happen as one that did not. That failure is logged, and the branch is
   * opened fresh.
   */
  private async settleSetAside(moving: Promise<void>, didMove: () => boolean, branch: string): Promise<void> {
    try {
      await moving;
    } catch (err) {
      if (!didMove()) throw err;
      log.error(
        `the working copy of "${branch}" was set aside, but what surrounds the move failed after it; the branch ` +
          'is opened fresh:',
        { detail: redactError(err, this.gitRunner.credentials.token()) },
      );
    }
  }

  /**
   * Whether the one repository is on disk, finished, and of an address that
   * is not the configured one. For a branch opened with nothing on disk: its
   * worktree would be added to that repository and fetch from the old
   * address.
   */
  private async isRepositoryOfAnother(): Promise<boolean> {
    if (!(await this.repository.exists())) return false;
    return this.isCloneOfAnotherRepository(this.repository.dir, 'knowledge-base repository');
  }

  private async isCloneOfAnotherRepository(repoDir: string, label?: string): Promise<boolean> {
    const configured = this.kbRepoUrl().trim();
    if (configured === '') return false;
    let origin: string;
    try {
      const { stdout } = await this.gitRunner.run(repoDir, ['config', '--get', 'remote.origin.url']);
      origin = stdout.trim();
    } catch {
      return false;
    }
    if (origin === '' || sameRepository(origin, configured)) return false;
    // Normalizing strips the userinfo but KEEPS the query string, and the
    // knowledge-base address is one that may carry its credential there (a
    // signed URL — see `urlQuerySecrets`). So the address is scrubbed on the
    // way into the log, exactly as the startup phase scrubs its own.
    log.warn(
      `the ${label ?? `"${path.basename(path.dirname(repoDir))}" working copy`} is a clone of another repository ` +
        `(${redactSecret(normalizeRepositoryAddress(origin), urlQuerySecrets(origin))}).`,
    );
    return true;
  }

  /**
   * How many times each working copy has been taken out from under this
   * process — see {@link forgetClone}. Deleting from the caches is not enough
   * on a RUNNING server: work already in flight against the copy that went
   * away finishes afterwards and writes its result back into those very
   * caches. So every such reader records the count it started with and checks
   * it before publishing: a count that moved means what it learned is about a
   * working copy that no longer exists, and is dropped.
   *
   * Keyed by workspace id, which is what the phase announces and what both
   * readers can derive (`workspaceIdForBranch`).
   */
  private readonly discardCount = new Map<string, number>();

  /**
   * Both readers and `forgetClone` go through this, so a caller's spelling of
   * a workspace id can never make them disagree about which working copy is
   * meant: the id is taken back to its branch and spelled afresh, which is the
   * one form the phase announces.
   */
  private discardKey(workspaceId: string): string {
    return workspaceIdForBranch(branchForWorkspaceId(workspaceId));
  }

  private discardsOf(workspaceId: string): number {
    return this.discardCount.get(this.discardKey(workspaceId)) ?? 0;
  }

  /**
   * Forget everything this process remembers about a working copy that was
   * taken away underneath it — the KB startup phase setting aside a clone of a
   * repository that was replaced.
   *
   * At boot there is nothing to forget; this is for the save that changes the
   * address on a RUNNING server, where `branchDirs` would otherwise keep
   * answering with the path of a directory that is gone and no later caller
   * would ever re-clone it. The branch NAME is deliberately left in
   * `branchesEverHeardOf` — the branch was real, and that record outlives
   * its clone.
   */
  forgetClone(workspaceId: string): void {
    const branch = branchForWorkspaceId(workspaceId);
    const workspaceDir = path.join(this.workspacesRoot, workspaceId);
    const repoDir = path.join(workspaceDir, this.kbDirName);
    this.discardCount.set(this.discardKey(workspaceId), this.discardsOf(workspaceId) + 1);
    this.branchDirs.delete(branch);
    this.lastFetchAt.delete(repoDir);
    this.lastFetchOk.delete(repoDir);
    // Dropped as well as un-stamped: the promise still running belongs to the
    // working copy that went away, so a caller that joined it would be told a
    // fetch of a directory that is gone refreshed the one that replaced it.
    // The count above is what stops that promise re-stamping the TTL when it
    // finally settles.
    this.inFlightFetches.delete(repoDir);
    // Keyed by branch, not by directory — see `stampCredentialHelper`.
    this.stampedCredentialFingerprint.delete(branch);
  }

  /**
   * Bring an adopted clone's config back to what a fresh clone would carry.
   *
   * Tracking: collapse it to a single fetch refspec and a single upstream ref
   * for `branch` (see `kb-fs/clone-config.ts`). A clone that accumulated a
   * second `remote.origin.fetch` refspec or `branch.<b>.merge` value makes git
   * refuse to refresh it — "Cannot rebase onto multiple branches" — which is
   * how a post-merge pull of the target branch fails.
   *
   * Credentials: re-stamp the helper. This is the repair for clones that never
   * got one — anything created by a build whose clone authenticated only its
   * own invocation, or by a deployment that had no token configured until
   * after the clone existed. Without it those clones are permanently
   * unpushable: nothing re-clones a directory that is already on disk, so no
   * restart, re-pull or settings change would ever fix them.
   *
   * Never throws: it only ever touches `.git/config`, so a failure leaves the
   * workspace exactly as usable as it was, and the git layer self-heals the
   * tracking keys before it pulls.
   */
  private async normalizeCloneConfig(repoDir: string, branch: string): Promise<void> {
    if (await this.isWorktree(repoDir)) {
      // A worktree reads the repository's one config: the branch's keys are
      // written there, one writer at a time, and the credential helper is the
      // repository's, stamped once for every worktree.
      try {
        await this.repository.writeConfig(repoDir, cloneTrackingConfigArgs(branch));
      } catch (err) {
        log.warn(`could not normalize the config of the "${branch}" worktree:`, {
          detail: redactError(err, this.gitRunner.credentials.token()),
        });
      }
      await this.repository.refreshCredentials();
      return;
    }
    try {
      for (const args of cloneTrackingConfigArgs(branch)) {
        await this.gitRunner.run(repoDir, args);
      }
    } catch (err) {
      // One line per branch, not per key: every key writes to the same
      // `.git/config`, so what fails for one fails for all.
      log.warn(`could not normalize the config of the "${branch}" clone:`, { detail: redactError(err, this.gitRunner.credentials.token()) });
    }
    await this.stampCredentialHelper(repoDir, branch);
  }

  /**
   * Fingerprint of the credential state a clone's helper is derived from: the
   * username (baked into the helper literal) and whether a token exists at all
   * (the helper is present-or-absent on that). The token VALUE is deliberately
   * excluded — the helper reads `$GITHUB_TOKEN` from the environment the
   * runner hands each git call, so rotating the token needs no re-stamp; only
   * a username change or a token appearing / disappearing does.
   */
  private credentialFingerprint(): string {
    const { credentials } = this.gitRunner;
    return `${credentials.username()}::${credentials.token() ? '1' : '0'}`;
  }

  /** Last credential fingerprint stamped into each branch's clone, this process. */
  private readonly stampedCredentialFingerprint = new Map<string, string>();

  /**
   * Bring `repoDir`'s credential helper into line with the current deployment
   * config (stamp when a token is set, unset when none is), and record the
   * fingerprint so the cached fast path can skip a no-op re-stamp. Runs the
   * config args tolerantly and one at a time: `--unset-all` on a clone that
   * never had a helper exits non-zero, and that must neither abort the rest
   * nor read as a failure.
   */
  private async stampCredentialHelper(repoDir: string, branch: string): Promise<void> {
    let argLists: string[][];
    try {
      argLists = cloneCredentialConfigArgs(this.gitRunner.credentials);
    } catch (err) {
      // `credentialHelperValue` fails closed on a username outside its safe
      // charset. Normally unreachable (CoreConfig and the settings service
      // validate first), but if a fourth, unvalidated path ever appears the
      // throw must not escape here: in the disk-adoption block it would land
      // in a catch that reads every error as "not on disk" and kick off a
      // re-clone that fails on the same validation — masking the real cause.
      // Contain it as a loud non-stamp instead; `normalizeCloneConfig`'s
      // never-throws contract stays true.
      log.warn(`refusing to stamp the credential helper of the "${branch}" clone:`, { detail: redactError(err, this.gitRunner.credentials.token()) });
      this.stampedCredentialFingerprint.delete(branch);
      return;
    }
    let stamped = true;
    for (const args of argLists) {
      try {
        await this.gitRunner.run(repoDir, args);
      } catch (err) {
        // `--unset-all` with no matching value (exit 5) is the expected no-op
        // for a clone that never carried an app helper; anything else is a
        // real failure.
        const code = (err as { exitCode?: number } | null)?.exitCode;
        if (!(args.includes('--unset-all') && code === 5)) {
          stamped = false;
          log.warn(`could not stamp the credential helper of the "${branch}" clone:`, {
            detail: redactError(err, this.gitRunner.credentials.token()),
          });
        }
      }
    }
    if (stamped) {
      this.stampedCredentialFingerprint.set(branch, this.credentialFingerprint());
    } else {
      // Recording the fingerprint after a FAILED write would make every later
      // cached open skip the retry as "already up to date" — the clone would
      // keep pushing with stale or missing credentials until a restart.
      // Dropping the entry keeps the fast path retrying until a stamp lands.
      this.stampedCredentialFingerprint.delete(branch);
    }
  }

  /**
   * Re-stamp a cached clone's credential helper when the deployment's
   * credential config changed since we last stamped it — the rotation case the
   * disk-adoption path in `getOrCreateForBranch` never reaches, because the
   * fast path returns before it. Without this, a token added (or a username
   * changed) through the setup screen after a branch was first opened would
   * never reach that branch's clone until a process restart, and its pushes
   * would keep failing exactly as in the original incident.
   */
  private async refreshCredentialHelperIfStale(branch: string, repoDir: string): Promise<void> {
    if (this.stampedCredentialFingerprint.get(branch) === this.credentialFingerprint()) return;
    if (await this.isWorktree(repoDir)) {
      // The repository's helper serves every worktree; it keeps its own
      // fingerprint, and a no-op costs no git.
      await this.repository.refreshCredentials();
      return;
    }
    await this.stampCredentialHelper(repoDir, branch);
  }

  /** The workspace ids whose checkout folder is a worktree (sound or broken) — a disk scan. */
  private async worktreeIdsOnDisk(): Promise<string[]> {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(this.workspacesRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await this.isWorktree(path.join(this.workspacesRoot, entry.name, this.kbDirName))) ids.push(entry.name);
    }
    return ids;
  }

  private async cloneProcessMapForBranch(workspaceDir: string, branch: string): Promise<void> {
    const targetDir = path.join(workspaceDir, this.kbDirName);

    // Probe whether `targetDir` exists. We split the existence check from
    // the inner `.git` validation so unexpected errors from EITHER probe
    // propagate to the caller instead of getting silently swallowed by an
    // outer catch (the previous shape let an inner rethrow fall through
    // to a clone-into-non-empty-dir, producing a confusing 500).
    //
    // A FILE squatting the clone's name is refused outright, never wiped:
    // the recovery below exists for a crashed bootstrap's directory shell,
    // and a regular file here is a state a human put the deployment in — so
    // it is named and stopped, the same stance the startup phase takes on a
    // squatted reserved root. (Links are followed: one clone mounted
    // elsewhere is the operator's business, as it is at the workspace root.)
    const target = await fs.stat(targetDir).catch((err: unknown) => {
      if (isAbsence(err)) return null;
      throw err;
    });
    if (target !== null && !target.isDirectory()) {
      throw new Error(
        `The clone path "${this.kbDirName}" in this workspace exists but is not a directory. ` +
          'Remove or rename it — the platform requires this name to be the knowledge-base clone.',
      );
    }

    if (target !== null) {
      // The directory exists, but a previous bootstrap may have crashed
      // midway — leaving a directory shell without `.git` — or it is a
      // worktree whose link to the repository is broken (the repository was
      // lost, or the worktree pruned from under it). Either is an unfinished
      // checkout: wipe it and add the worktree again. A working worktree, or a
      // full clone from an earlier release, is adopted as it is.
      let shape;
      try {
        shape = await workingCopyShape(targetDir);
      } catch (err) {
        // Only treat "does-not-exist" as "half-built dir, wipe and
        // re-clone". A transient EACCES / EIO / EBUSY must NOT delete
        // what might be a perfectly valid repo whose `.git` we couldn't
        // read this moment — surface the error so the caller can retry.
        // (`targetDir` is known to be a directory here, so ENOTDIR can only
        // mean `.git` itself vanished under us — an absence either way.)
        if (!isAbsence(err)) throw err;
        shape = 'none' as const;
      }
      if (shape === 'worktree' || shape === 'clone') {
        // We don't auto-pull because that could clobber another user's
        // in-progress lock-held edits. The CONFIG is re-stamped though — it
        // never touches the working tree, and a clone with drifted tracking
        // or a missing credential helper is one that can't pull or push.
        await this.normalizeCloneConfig(targetDir, branch);
        return;
      }
      if (shape === 'broken') {
        log.warn(`the "${branch}" worktree had lost its link to the repository; it is added again.`);
      }
      // Half-built dir — wipe and add the worktree again.
      await fs.rm(targetDir, { recursive: true, force: true });
    }

    try {
      // A worktree of the one repository: no history is copied. The
      // repository is created and fetched first if this is the first branch
      // opened on the deployment, and the identity, the long-paths setting,
      // the credential helper and the branch's tracking config are the
      // repository's (see `KbRepository`). The add asks the remote for the
      // branch, so the worktree starts at its tip as a fresh clone would.
      await this.repository.addWorktree(branch, targetDir);
      log.info(`Added the ${this.kbDirName} worktree for branch "${branch}"`);
      // A working copy was just made — tell the git layer, so a fetch record
      // it kept for this workspace id (a clone it replaced) is not read as
      // this one's, and the first `listBranches` skips a redundant fetch.
      // Isolated from the clone-rollback `catch` below: a misbehaving listener
      // must not cause a successful clone to be wiped.
      try {
        this.onWorkspaceCloned?.(workspaceIdForBranch(branch));
      } catch (listenerErr) {
        log.error(`onWorkspaceCloned listener failed for branch "${branch}":`, {
          detail: redactError(listenerErr, this.gitRunner.credentials.token()),
        });
      }
    } catch (err) {
      const redacted = redactError(err, this.gitRunner.credentials.token());
      // Roll back partial state so the next bootstrap retries cleanly.
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      await this.repository.prune().catch(() => {});
      // A branch origin does not have is a fact about the branch, not a
      // failure of ours — but WHICH fact depends on whether the platform ever
      // knew the name. A branch it cloned or listed and origin no longer has
      // was deleted (410, "this branch no longer exists"); a name it has
      // never seen is simply not a branch (404), and saying "no longer exists
      // on the remote" to a typo tells the reader it once did.
      if (isMissingRemoteBranchFailure(redacted)) {
        let everHeardOf: boolean;
        try {
          everHeardOf = await this.hasHeardOfBranch(branch);
        } catch (probeErr) {
          // We could not read our own storage, so we cannot say which of the
          // two stories this is — and guessing either one states something
          // about the branch that we do not know. Our failure, so: 500.
          log.error(`Could not tell whether branch "${branch}" was ever known here:`, {
            detail: redactError(probeErr, this.gitRunner.credentials.token()),
          });
          throw new Error(`Failed to clone process map: ${redacted}`);
        }
        if (everHeardOf) {
          log.info(`branch "${branch}" is gone from origin — nothing to clone`);
          throw new RemoteBranchGoneError(branch);
        }
        log.info(`branch "${branch}" has never existed here — nothing to clone`);
        throw new BranchNotFoundError(branch);
      }
      log.error(`Failed to clone for branch "${branch}":`, { detail: redacted });
      throw new Error(`Failed to clone process map: ${redacted}`);
    }
  }

  async getMetadata(workspaceId: string): Promise<WorkspaceInfo | null> {
    try {
      const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
      return this.buildWorkspaceInfo(branchForWorkspaceId(workspaceId), workspaceDir);
    } catch {
      return null;
    }
  }

  /**
   * Delete a branch's workspace directory entirely. Used when a branch is
   * deleted upstream — frees the disk used by its clone. The branch's git
   * history on origin is unaffected.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const branch = branchForWorkspaceId(workspaceId);
    const repoDir = path.join(workspaceDir, this.kbDirName);
    // A worktree is removed through git and pruned from the repository, with
    // its branch's local ref; the repository's objects and every other
    // worktree are untouched.
    if (await this.isWorktree(repoDir)) await this.repository.removeWorktree(repoDir, branch);
    await fs.rm(workspaceDir, { recursive: true, force: true });
    this.branchDirs.delete(branch);
  }

  async listFiles(workspaceId: string, readFilter?: ReadTreeFilter): Promise<FileTreeEntry> {
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    return this.buildFileTree(workspaceDir, workspaceDir, readFilter);
  }

  /**
   * The part of the tree at `wsPath`: a folder's subtree exactly as
   * {@link listFiles} holds it (the same read filter, `.bevelignore` rules,
   * order and workspace-relative paths), built by walking that folder alone.
   * A file answers its own entry, when the filter lets the caller read it.
   * `null` when nothing is at the path, when it is not a file or a folder, or
   * when a `.bevelignore` above it hides it, as the whole tree would not show
   * it either.
   *
   * The folder's own readability is the caller's question, as it is for the
   * workspace root in `listFiles`: the filter judges what is INSIDE.
   */
  async listFilesUnder(
    workspaceId: string,
    wsPath: string,
    options: { readFilter?: ReadTreeFilter } = {},
  ): Promise<FileTreeEntry | null> {
    return this.entryUnder(await this.located(workspaceId, wsPath), options);
  }

  /** {@link listFilesUnder}, for the place its path resolved to. */
  private async entryUnder(
    at: { workspaceDir: string; relativePath: string; absolutePath: string },
    options: { readFilter?: ReadTreeFilter },
  ): Promise<FileTreeEntry | null> {
    const { workspaceDir, relativePath, absolutePath } = at;
    assertNoGitInternalsSegment(relativePath);
    await assertNotGitInternals(workspaceDir, relativePath, absolutePath);
    await this.assertNotThroughLink(absolutePath, workspaceDir);
    let stat;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (err) {
      if (isAbsence(err)) return null;
      throw err;
    }
    if (!stat.isFile() && !stat.isDirectory()) return null;
    const repoRoot = path.join(workspaceDir, this.kbDirName);
    const inRepo = (relativePath === this.kbDirName ? '' : relativePath.slice(this.kbDirName.length + 1)).replace(/\/+$/, '');
    // The rules above the entry, and whether one of them hides it or a folder
    // on the way to it.
    const parent = inRepo.includes('/') ? inRepo.slice(0, inRepo.lastIndexOf('/')) : '';
    const above = await ignoreRulesAbove(repoRoot, stat.isDirectory() ? inRepo : parent);
    if (!above) return null;
    if (stat.isFile()) {
      const rules = await above.extendedWith(path.dirname(absolutePath));
      if (rules.isIgnored(absolutePath, false)) return null;
      const name = path.basename(absolutePath);
      if (isFolderPlaceholder(name)) return null;
      if (options.readFilter && (await options.readFilter([relativePath])).get(relativePath) !== true) return null;
      return { name, relativePath, type: 'file' };
    }
    return this.buildFileTree(absolutePath, workspaceDir, options.readFilter, above);
  }

  /** The repository inside a workspace directory: `<workspaceDir>/<kbDirName>`. */
  private repoRoot(workspaceDir: string): string {
    return path.join(workspaceDir, this.kbDirName);
  }

  /**
   * THE resolution — the only place in this service that turns a workspace
   * path into a location on disk.
   *
   * Two steps, and neither is optional. `normalizeWorkspacePath` places the
   * path inside the repository (`KnowledgeBase/Report.md` is the page of that
   * name in the checkout, not a stray beside it) and refuses `.`/`..`,
   * backslashes and absolute paths outright. Then the RESOLVED path is checked
   * against `<workspaceDir>/<kbDirName>` — after normalisation, because that
   * is the path the operation will use, and a spelling that normalises inside
   * and resolves outside is exactly the miss this check exists to catch.
   *
   * The git rule reads the caller's RAW spelling before either step — the
   * whole rule, links resolved, not just the spelling. Those two refuse
   * `.`/`..`, backslashes and absolute paths with a message that quotes the
   * path back and names a corrected one, and a git path spelled any of those
   * ways was answered by THAT rather than by the one sanitized refusal
   * (measured in production), as was a LINK into the folder spelled the same
   * ways. Which rule speaks is not the caller's to choose.
   *
   * Callers use the returned `relativePath` for everything downstream — the
   * git-internals check, the diff baseline, the lock-free path turns, their own
   * error messages — so what is checked is what is written. Nine inline
   * `path.resolve(workspaceDir, …)` calls used to do this, none of them
   * checking the repository root; a drift-guard test now fails if one returns.
   */
  private async resolveInsideRepo(
    workspaceId: string,
    wsPath: string,
  ): Promise<{ workspaceDir: string; relativePath: string; absolutePath: string }> {
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    await assertNotGitInternals(workspaceDir, wsPath); // The RAW spelling, first — see above.
    const relativePath = normalizeWorkspacePath(wsPath, this.kbDirName);
    const absolutePath = path.resolve(workspaceDir, relativePath);
    assertWithinDirectory(absolutePath, this.repoRoot(workspaceDir));
    return { workspaceDir, relativePath, absolutePath };
  }

  /** The resolution above, for a method this file declares before it. */
  private located(workspaceId: string, wsPath: string): Promise<{ workspaceDir: string; relativePath: string; absolutePath: string }> {
    return this.resolveInsideRepo(workspaceId, wsPath);
  }

  async readFile(workspaceId: string, wsPath: string): Promise<string> {
    const { workspaceDir, relativePath, absolutePath } = await this.resolveInsideRepo(workspaceId, wsPath);
    assertNoGitInternalsSegment(relativePath);
    await assertNotGitInternals(workspaceDir, relativePath, absolutePath);
    await this.assertNotThroughLink(absolutePath, workspaceDir);
    return fs.readFile(absolutePath, 'utf-8');
  }

  async readFileBinary(workspaceId: string, wsPath: string): Promise<Buffer> {
    const { workspaceDir, relativePath, absolutePath } = await this.resolveInsideRepo(workspaceId, wsPath);
    assertNoGitInternalsSegment(relativePath);
    await assertNotGitInternals(workspaceDir, relativePath, absolutePath);
    await this.assertNotThroughLink(absolutePath, workspaceDir);
    return fs.readFile(absolutePath);
  }

  /**
   * Whether a FILE is at `wsPath` — the same guards as a read, without the
   * read: for a caller that only has to know the file is there (the embed
   * mint), on a file that may be hundreds of megabytes.
   */
  async isFile(workspaceId: string, wsPath: string): Promise<boolean> {
    const { workspaceDir, relativePath, absolutePath } = await this.resolveInsideRepo(workspaceId, wsPath);
    assertNoGitInternalsSegment(relativePath);
    await assertNotGitInternals(workspaceDir, relativePath, absolutePath);
    await this.assertNotThroughLink(absolutePath, workspaceDir);
    try {
      return (await fs.stat(absolutePath)).isFile();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw err;
    }
  }

  /**
   * Refuse a path that reaches its file through a symbolic link — as the
   * final component, or as any directory between the workspace root and it.
   * `resolveInsideRepo`'s containment is lexical: `knowledge-base/notes.md`
   * passes it however the name resolves, so a link the repository carries (they only
   * arrive by direct git push; the app's own writes never create one) would
   * let a read hand out bytes from anywhere the server process can read, and
   * a write replace whatever the link points at. The rule is the plugin
   * archive's: the deepest ancestor that exists must resolve to exactly its
   * own spelling under the workspace's resolved root — identity, not mere
   * containment — and the entry itself, when it exists, must not be a link.
   * The workspace root may sit behind a link of the operator's (a mounted
   * volume): both sides are resolved, so that is allowed.
   *
   * The same refusal as the lexical check on purpose: this IS a traversal,
   * reached through a link rather than through a spelling.
   */
  private async assertNotThroughLink(absolutePath: string, workspaceDir: string): Promise<void> {
    const traversal = () => new PathTraversalError();
    const entry = await fs.lstat(absolutePath).catch((err: unknown) => {
      if (isAbsence(err)) return null;
      throw err;
    });
    if (entry?.isSymbolicLink()) throw traversal();
    // The deepest existing ancestor: a write creates the rest, under it. Each
    // ancestor is lstat-ed BEFORE its absence is taken as leave to climb: a
    // dangling link resolves to nothing too, and climbing past it would let
    // a target created in the meantime receive the write.
    let ancestor = path.dirname(absolutePath);
    let realAncestor: string | null = null;
    while (realAncestor === null) {
      const ancestorEntry = await fs.lstat(ancestor).catch((err: unknown) => {
        if (isAbsence(err)) return null;
        throw err;
      });
      // The workspace directory itself may be a link of the operator's (one
      // workspace mounted elsewhere), like the root above it; the identity
      // check below still holds everything beneath it to its own spelling.
      if (ancestorEntry?.isSymbolicLink() && path.resolve(ancestor) !== path.resolve(workspaceDir)) throw traversal();
      realAncestor = await fs.realpath(ancestor).catch((err: unknown) => {
        if (isAbsence(err)) return null;
        throw err;
      });
      if (realAncestor === null) {
        const up = path.dirname(ancestor);
        if (up === ancestor) throw traversal();
        ancestor = up;
      }
    }
    const realRoot = await fs.realpath(workspaceDir);
    const expected = path.join(realRoot, path.relative(path.resolve(workspaceDir), ancestor));
    const same =
      process.platform === 'win32'
        ? realAncestor.toLowerCase() === expected.toLowerCase()
        : realAncestor === expected;
    if (!same) throw traversal();
  }

  /**
   * Read every `.md` file under the KB repo in one disk pass, keyed by
   * repo-root-relative POSIX path (e.g. `Product/NodeTypes/ServiceCommitment.md`)
   * — the form `parseGraph` keys its file map on. Respects `.git/` and
   * `.bevelignore` like the file tree, so the iframe's `buildGraph()` sees the
   * same set the explorer shows. This exists so the HTML renderer can fetch the
   * whole KB in a single request instead of one HTTP round-trip per file (the
   * KB is thousands of files; per-file fetching exhausts the browser's
   * connection pool).
   */
  async readAllKbFiles(workspaceId: string): Promise<Record<string, string>> {
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const repoRoot = path.join(workspaceDir, this.kbDirName);
    const files: Record<string, string> = {};
    await this.disk.walk(repoRoot, explorerWalk(), [
      {
        async onFile(dir, name) {
          if (!name.endsWith('.md')) return;
          const repoPath = dir ? `${dir}/${name}` : name;
          files[repoPath] = await fs.readFile(path.join(repoRoot, dir, name), 'utf-8');
        },
      },
    ]);
    return files;
  }

  /**
   * Build a zip archive of the folder at `relativePath` and return it as a
   * single buffer. Mirrors the file-tree's skip rules — `.git/`, `.gitkeep`,
   * and `.bevelignore`-excluded paths are omitted so the zip matches what
   * the user sees in the explorer (and so we don't leak the entire git
   * object database into a download).
   *
   * Entry names inside the zip are prefixed with the folder's own name so
   * unzipping yields `<folderName>/...` rather than spilling files into the
   * caller's cwd. Throws `FolderTooLargeError` if cumulative uncompressed
   * size crosses `ZIP_DOWNLOAD_MAX_BYTES`. Buffered in memory (adm-zip has
   * no streaming API); the cap therefore doubles as a peak-heap bound.
   */
  /**
   * Zip a folder. `include` is asked, ONCE, which of the folder's files may
   * go in: it is handed every file the walk found, as repository-relative
   * paths, and answers the set to pack. Required, not optional, and with no
   * default that packs everything: the route used to gate `download` on the
   * folder alone and pack every file under it, so a caller with `download`
   * on a folder got files whose own rules (frontmatter, a nested access.md)
   * denied them `read` or `download` — files the per-file route refused and
   * the file tree never showed. A caller that wants everything says so by
   * returning everything; it cannot get it by saying nothing.
   *
   * Two passes rather than a judgement per file inside the walk: the access
   * model answers a list in one load, and a folder of a thousand files is
   * the case a per-file call would make slow. The size cap counts only the
   * files packed; a withheld file costs nothing and reveals nothing.
   */
  async createFolderZip(workspaceId: string, wsPath: string, include: ZipEntryFilter): Promise<Buffer> {
    const { workspaceDir, relativePath, absolutePath: absoluteRoot } = await this.resolveInsideRepo(workspaceId, wsPath);
    assertNoGitInternalsSegment(relativePath);
    await assertNotGitInternals(workspaceDir, relativePath, absoluteRoot);
    const stat = await fs.stat(absoluteRoot);
    if (!stat.isDirectory()) {
      throw new Error('Not a directory');
    }

    // `relativePath` is workspace-relative, `<kbDirName>/<folder>`; the
    // access rules are keyed inside the repository, so the prefix comes off
    // here (and the repository root itself is the empty prefix).
    // A trailing slash the caller wrote (`docs/`) survives normalisation and
    // would key every file as `docs//x.md`, which no verdict matches: the
    // filter would then withhold the whole folder in silence.
    const folderInRepo = (relativePath === this.kbDirName ? '' : relativePath.slice(this.kbDirName.length + 1)).replace(/\/+$/, '');
    const found: { dir: string; name: string; repoRelative: string }[] = [];
    await this.disk.walk(absoluteRoot, explorerWalk(), [
      {
        async onFile(dir, name) {
          found.push({ dir, name, repoRelative: [folderInRepo, dir, name].filter(Boolean).join('/') });
        },
      },
    ]);
    const allowed = await include(found.map((f) => f.repoRelative));

    const zipRoot = path.basename(absoluteRoot) || 'folder';
    const zip = new AdmZip();
    let totalBytes = 0;
    for (const { dir, name, repoRelative } of found) {
      if (!allowed.has(repoRelative)) continue;
      const childAbs = path.join(absoluteRoot, dir, name);
      // Check the size cap BEFORE reading the file into memory. Reading
      // first would let a single hostile 2 GB file allocate the whole
      // buffer before the throw — defeating the cap as a peak-heap
      // bound. `stat.size` is an upper bound that we re-verify after
      // the read in case the file grew between stat and readFile.
      const stat = await fs.stat(childAbs);
      if (totalBytes + stat.size > ZIP_DOWNLOAD_MAX_BYTES) {
        throw new FolderTooLargeError(ZIP_DOWNLOAD_MAX_BYTES);
      }
      const data = await fs.readFile(childAbs);
      if (totalBytes + data.byteLength > ZIP_DOWNLOAD_MAX_BYTES) {
        throw new FolderTooLargeError(ZIP_DOWNLOAD_MAX_BYTES);
      }
      totalBytes += data.byteLength;
      // Path inside the archive: <folderName>/<relPathUnderFolder>, POSIX
      // separators regardless of host OS so the zip extracts cleanly
      // on Windows/Mac/Linux alike.
      zip.addFile(`${zipRoot}/${dir ? `${dir}/${name}` : name}`, data);
    }
    return zip.toBuffer();
  }

  /**
   * What is at `wsPath`, for an agent download: nothing, one file, or a folder
   * and every file the explorer shows under it (the folder download's walk —
   * no `.git/`, no `.gitkeep`, no `.bevelignore`d path, no link). Files come
   * back repository-relative, with their size on disk; nothing is read, and
   * nothing is judged — the caller judges every path on its own.
   *
   * The `.bevelignore` rules are those in force at the folder, its ancestors'
   * included, as the explorer's walk from the root has them: a folder an
   * ancestor's rule hides holds no files. The whole folder is walked, as the
   * explorer walks it: a cap here would be a cap on files the caller may not
   * read as much as on the ones they may, and the limit a request is held to
   * is the caller's own count, judged after the read verdicts.
   *
   * A path that reaches its target through a link, or names the git folder,
   * is refused as the reads refuse it; a path with nothing at it is
   * `missing`, which the caller answers exactly as a path it may not read.
   */
  async downloadCandidatesAt(
    workspaceId: string,
    wsPath: string,
  ): Promise<{ kind: 'missing' } | { kind: 'file' | 'folder'; files: { path: string; bytes: number }[] }> {
    const { workspaceDir, relativePath, absolutePath } = await this.resolveInsideRepo(workspaceId, wsPath);
    assertNoGitInternalsSegment(relativePath);
    await assertNotGitInternals(workspaceDir, relativePath, absolutePath);
    await this.assertNotThroughLink(absolutePath, workspaceDir);
    let stat;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') {
        return { kind: 'missing' };
      }
      throw err;
    }
    const inRepo = (relativePath === this.kbDirName ? '' : relativePath.slice(this.kbDirName.length + 1)).replace(/\/+$/, '');
    if (stat.isFile()) return { kind: 'file', files: [{ path: inRepo, bytes: stat.size }] };
    if (!stat.isDirectory()) return { kind: 'missing' };
    const files: { path: string; bytes: number }[] = [];
    const rules = await ignoreRulesAbove(path.join(workspaceDir, this.kbDirName), inRepo);
    if (!rules) return { kind: 'folder', files };
    await this.disk.walk(absolutePath, { ...explorerWalk(), ignore: rules }, [
      {
        async onFile(dir, name) {
          const size = (await fs.lstat(path.join(absolutePath, dir, name))).size;
          files.push({ path: [inRepo, dir, name].filter(Boolean).join('/'), bytes: size });
        },
      },
    ]);
    return { kind: 'folder', files };
  }

  /**
   * Read a file's contents as it exists on a specific git ref in the
   * branch's clone. Returns null when the ref or path doesn't exist on that
   * ref. `relativePath` is relative to the repo root (e.g. `Knowledge/Foo.md`),
   * NOT to the workspace dir — the repo sits at `<workspaceDir>/knowledge-base`.
   */
  async readFileAtRef(
    workspaceId: string,
    ref: string,
    relativePath: string,
  ): Promise<string | null> {
    this.assertValidGitRef(ref);
    assertNoGitInternalsSegment(relativePath);
    this.assertValidRepoRelativePath(relativePath);
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const repoDir = path.join(workspaceDir, this.kbDirName);

    const candidates = [ref];
    if (!ref.startsWith('origin/') && !ref.startsWith('refs/')) {
      candidates.push(`origin/${ref}`);
    }

    for (const candidate of candidates) {
      try {
        const { stdout } = await this.gitRunner.run(repoDir, ['show', `${candidate}:${relativePath}`]);
        return stdout;
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  /**
   * Run `git fetch --prune origin` for this branch's clone. Results are
   * cached for `FETCH_CACHE_TTL_MS`; concurrent callers share the same
   * in-flight fetch to avoid fetch storms when e.g. the CR list poll fans out.
   *
   * `force` skips the TTL — for a caller that KNOWS the remote just moved
   * (an event-driven `?fresh=1` read, which bypasses its own cache for the
   * same reason) and would otherwise answer from refs older than the change
   * it is being asked about. It keeps the in-flight join, which is the half
   * that actually prevents storms: ten forced callers in the same tick still
   * share one fetch.
   */
  async ensureRemotesFetched(
    workspaceId: string,
    opts: { strict?: boolean; force?: boolean } = {},
  ): Promise<void> {
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const repoDir = path.join(workspaceDir, this.kbDirName);
    if (await this.isWorktree(repoDir)) {
      // ONE fetch for every workspace: the repository's, throttled and joined
      // there.
      const ok = await this.repository.fetch({ maxAgeMs: FETCH_CACHE_TTL_MS, force: opts.force });
      if (opts.strict && !ok) throw new Error('git fetch origin failed — remote refs could not be refreshed');
      return;
    }
    // A full clone from an earlier release fetches on its own until the boot
    // phase converts it.
    const now = Date.now();
    // The TTL is stamped only by a SUCCESSFUL fetch, so a fresh window is
    // itself the proof a strict caller wants.
    const last = this.lastFetchAt.get(repoDir) ?? 0;
    if (!opts.force && now - last < FETCH_CACHE_TTL_MS) return;

    const inFlight = this.inFlightFetches.get(repoDir);
    if (inFlight) {
      await inFlight;
      // `strict` callers use the refs to AUTHORIZE or to prove absence; the
      // swallow-and-degrade below is right for the polling paths and wrong
      // for them — a failed fetch must surface, never pass as freshness.
      if (opts.strict && !this.lastFetchOk.get(repoDir)) {
        throw new Error('git fetch origin failed — remote refs could not be refreshed');
      }
      return;
    }

    // This driver runs outside the git layer's per-workspace mutex, so it may
    // only run the safe implicit-fetch shape — see `SAFE_IMPLICIT_FETCH_ARGS`
    // in `kb-fs/clone-config.ts` for the full rationale.
    // What this fetch is ABOUT: the working copy in that directory as it is
    // now. Should the repository be replaced while the fetch runs, the copy is
    // set aside and a fresh one is cloned to the SAME path — so stamping the
    // result afterwards would hand the new clone a freshness it never earned
    // (or a failure that was the old one's), and the next reader would skip
    // refreshing it for the whole TTL.
    const discardsAtFetch = this.discardsOf(workspaceId);
    const stillTheSameClone = (): boolean => this.discardsOf(workspaceId) === discardsAtFetch;
    const promise = this.gitRunner
      .run(repoDir, [...SAFE_IMPLICIT_FETCH_ARGS])
      .then(() => {
        if (!stillTheSameClone()) return;
        this.lastFetchAt.set(repoDir, Date.now());
        this.lastFetchOk.set(repoDir, true);
      })
      .catch((err) => {
        if (stillTheSameClone()) this.lastFetchOk.set(repoDir, false);
        log.warn('git fetch origin failed:', { detail: redactError(err, this.gitRunner.credentials.token()) });
      })
      .finally(() => {
        if (this.inFlightFetches.get(repoDir) === promise) {
          this.inFlightFetches.delete(repoDir);
        }
      });
    this.inFlightFetches.set(repoDir, promise);
    await promise;
    if (opts.strict && !this.lastFetchOk.get(repoDir)) {
      throw new Error('git fetch origin failed — remote refs could not be refreshed');
    }
  }

  private assertValidGitRef(ref: string): void {
    if (!ref) throw new Error('Git ref is required');
    if (ref.startsWith('-') || /[\s\0]/.test(ref)) {
      throw new Error('Invalid git ref');
    }
  }

  private assertValidRepoRelativePath(relativePath: string): void {
    if (!relativePath) throw new Error('Repo-relative path is required');
    if (relativePath.startsWith('-') || relativePath.includes('\0')) {
      throw new Error('Invalid repo-relative path');
    }
  }

  async deleteFile(workspaceId: string, wsPath: string): Promise<void> {
    const { workspaceDir, relativePath, absolutePath } = await this.resolveInsideRepo(workspaceId, wsPath);
    assertNoGitInternalsSegment(relativePath);
    // Under the path's turn like every other single-file mutation: a delete
    // landing between a conditional write's compare and its write would let
    // that write recreate the file the delete had just removed. The diff
    // baseline is updated inside the same turn, so two mutations of one path
    // update it in the order they landed on disk. The resolved git check runs
    // inside the turn too (see `withPathTurn`), so it cannot reorder callers.
    await this.withResolvedPathTurn(absolutePath, async () => {
      await assertNotGitInternals(workspaceDir, relativePath, absolutePath);
      await fs.rm(absolutePath, { recursive: true, force: true });
      await this.diffService?.markUserDeleted(workspaceId, relativePath);
    });
  }

  /**
   * The bytes of the one file a tmp ref (`__tmp__/<path>`, see
   * `workspace-tmp.ts`) names in `ownerId`'s own folder of this workspace's
   * `tmp/`, under the ref's rules: one file, nothing outside that folder, and
   * a missing file — what somebody else staged included — a
   * `PathNotFoundError` naming the ref. This is how a distribution's own tool
   * reads a staged file without a reader of its own; the file tools read the
   * folder through the same resolver, as the calling user.
   */
  async readTmpFile(workspaceId: string, ownerId: string, ref: string): Promise<Buffer> {
    return readTmpRef(this.workspaceDirForTmp(workspaceId), ownerId, ref);
  }

  /**
   * What `file_stat` reports for a tmp ref: the stat of the one file it names
   * in `ownerId`'s folder of this workspace's `tmp/`, resolved exactly as
   * {@link readTmpFile} resolves it.
   */
  async statTmpFile(workspaceId: string, ownerId: string, ref: string): Promise<TmpFileStat> {
    return statTmpRef(this.workspaceDirForTmp(workspaceId), ownerId, ref);
  }

  /**
   * Stage `bytes` in `ownerId`'s folder of this workspace's `tmp/`, at
   * `relativePath` inside it, and answer the ref (`__tmp__/<relativePath>`)
   * the owner reads it back with. The one way into the folder the ref
   * reaches — a stager (the chat's attachments, a reader of an external
   * document) calls this rather than composing the path, so where an owner's
   * files live is decided here once. Needs no bootstrap: a staged file
   * belongs beside the checkout, whether or not the branch is cloned yet.
   */
  async stageTmpFile(workspaceId: string, ownerId: string, relativePath: string, bytes: Uint8Array): Promise<string> {
    return stageTmpRef(this.workspaceDirForTmp(workspaceId), ownerId, relativePath, bytes);
  }

  /**
   * Remove, in every workspace directory under the root, each entry of its
   * `tmp/` folder last modified more than `olderThanMs` ago — the platform's
   * periodic cleanup (see `TmpSweeper`). Judged on the entry's own `lstat`,
   * never through a link. Returns how many entries went, per workspace.
   * An aborted `signal` ends the sweep at the next entry (see `TmpSweeper`).
   */
  async sweepTmp(
    olderThanMs: number = TMP_MAX_AGE_MS,
    now: number = Date.now(),
    signal?: AbortSignal,
  ): Promise<{ removed: Record<string, number> }> {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(this.workspacesRoot, { withFileTypes: true });
    } catch (err) {
      if (isAbsence(err)) return { removed: {} };
      throw err;
    }
    const removed: Record<string, number> = {};
    for (const entry of entries) {
      if (signal?.aborted) break;
      if (!entry.isDirectory()) continue;
      try {
        const gone = await sweepTmpFolder(this.disk, path.join(this.workspacesRoot, entry.name), olderThanMs, now, signal);
        if (gone.length > 0) removed[entry.name] = gone.length;
      } catch (err) {
        // One unreadable workspace spoils its own sweep, not the others'.
        log.warn(`tmp sweep failed for ${entry.name}:`, { err });
      }
    }
    return { removed };
  }

  /**
   * The workspace directory a tmp ref resolves against, computed without
   * bootstrapping (a branch never cloned has nothing staged): the root's own
   * containment rule ({@link workspaceDirWithinRoot}), and not the root
   * itself, which that rule allows — `<root>/tmp` is no workspace's folder.
   */
  private workspaceDirForTmp(workspaceId: string): string {
    const dir = this.workspaceDirWithinRoot(workspaceId);
    if (dir === path.resolve(this.workspacesRoot)) {
      throw new Error(`Invalid workspace ID "${workspaceId}": a tmp ref resolves inside one workspace directory.`);
    }
    return dir;
  }

  /**
   * Remove the workspace's `tmp/` directory — transient run artifacts (code-mode
   * tool-chain spills, staged SharePoint docs) that live at the workspace root,
   * outside the KB git repo, and are never committed. Computes the path directly
   * from `workspacesRoot` (no bootstrapping) and force-removes, so it's safe to
   * call after a run even if the workspace was already torn down — a missing
   * directory is ignored. Everyone's staged files go with it, which is why the
   * ref's promise is "up to seven days" (see `workspace-tmp.ts`).
   */
  async clearTmp(workspaceId: string): Promise<void> {
    // Guard against a malicious/odd workspaceId (e.g. "..") escaping the root
    // and force-removing an unintended directory.
    const root = path.resolve(this.workspacesRoot);
    const tmpDir = path.resolve(root, workspaceId, 'tmp');
    if (!tmpDir.startsWith(root + path.sep)) {
      throw new Error(`clearTmp: refusing to remove a path outside the workspaces root (workspaceId="${workspaceId}").`);
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  /**
   * Rename or move one entry.
   *
   * Deliberately NOT under {@link withPathTurn}: a move mutates two paths, and
   * holding both turns would introduce the one shape that can deadlock here
   * (a move waiting on a target whose holder is waiting on the move's other
   * path). A rename onto a path being conditionally written is therefore
   * outside that guarantee; the version-control lock on the moved path is what
   * serializes it against the app's own editors.
   */
  async moveEntry(workspaceId: string, oldWsPath: string, newWsPath: string): Promise<void> {
    const { workspaceDir, relativePath: oldRelativePath, absolutePath: oldAbsolute } =
      await this.resolveInsideRepo(workspaceId, oldWsPath);
    const { relativePath: newRelativePath, absolutePath: newAbsolute } =
      await this.resolveInsideRepo(workspaceId, newWsPath);
    // A move and a rename are the same call, so this is where the checkout's
    // own name is reserved at the repository root for both.
    assertRepoRootNameFree(newRelativePath, this.kbDirName);
    assertNoGitInternalsSegment(oldRelativePath);
    assertNoGitInternalsSegment(newRelativePath);
    assertValidPath(newRelativePath);
    await assertNotGitInternals(workspaceDir, oldRelativePath, oldAbsolute);
    await assertNotGitInternals(workspaceDir, newRelativePath, newAbsolute);
    // Both ends: a link on the way to either end would carry the rename
    // outside. A link used AS the source is refused too — a committed link
    // is not something the app moves around, any more than reads it.
    await this.assertNotThroughLink(oldAbsolute, workspaceDir);
    await this.assertNotThroughLink(newAbsolute, workspaceDir);
    // Before `mkdir`, so a refused move leaves no empty folder behind — and
    // it is the look that produces the sentence naming what is in the way.
    await this.assertDestinationFree(oldAbsolute, newAbsolute, newRelativePath);
    await fs.mkdir(path.dirname(newAbsolute), { recursive: true });
    // The move itself cannot replace anything either, so a destination that
    // appears between the look above and this line is refused rather than
    // eaten (`shared/rename-no-replace.ts`). This path takes no lock on
    // purpose — see the note above — so the atomicity has to come from the
    // filesystem call.
    try {
      await renameNoReplace(oldAbsolute, newAbsolute, newRelativePath);
    } catch (err) {
      if (err instanceof DestinationTakenError) {
        throw new EntryExistsError(err.entryKind, newRelativePath);
      }
      throw err;
    }
    if (this.diffService) {
      await this.diffService.markUserDeleted(workspaceId, oldRelativePath);
      await this.diffService.syncFromDisk(workspaceId, newRelativePath);
    }
  }

  /**
   * Refuse a move onto a name that is taken. `fs.rename` REPLACES an existing
   * file on every platform — that is how renaming a `.docx` onto an existing
   * `.md` handed the markdown file the Word bytes — so the destination is
   * looked at first, and a move never overwrites a file or merges into a
   * folder.
   *
   * Judged by `inspectDestination`, which reads a case-only rename on a
   * case-insensitive filesystem — where `notes.md` → `Notes.md` finds the
   * SOURCE at the destination — as the rename that was asked for rather than a
   * clash, and everything else as a clash. It is the same reading the move
   * itself uses, so the sentence and the refusal cannot drift apart.
   */
  private async assertDestinationFree(
    oldAbsolute: string,
    newAbsolute: string,
    newRelativePath: string,
  ): Promise<void> {
    const verdict = await inspectDestination(oldAbsolute, newAbsolute);
    if (verdict.state === 'taken') throw new EntryExistsError(verdict.kind, newRelativePath);
  }

  /**
   * Refuse a conditional write, with the same 409 {@link writeFile} throws,
   * without writing anything. The route calls this BEFORE the creator-access
   * plan: that plan can commit a seeded `access.md` under its own lock, and a
   * precondition failing after it would leave an authorization grant behind
   * for a save that never landed. The write's own compare, under its write
   * turn, stays the authoritative one; this only keeps the refusal free of
   * side effects.
   */
  async assertContentMatches(
    workspaceId: string,
    wsPath: string,
    expectedContent: string,
  ): Promise<void> {
    const { workspaceDir, relativePath, absolutePath } = await this.resolveInsideRepo(workspaceId, wsPath);
    assertNoGitInternalsSegment(relativePath);
    assertValidPath(relativePath);
    await assertNotGitInternals(workspaceDir, relativePath, absolutePath);
    await assertConditionalWriteMatches(absolutePath, relativePath,expectedContent);
  }

  /**
   * Run `op` as the only mutation in flight for `relativePath` in this
   * process, so a read-then-decide-then-write sequence inside it cannot have
   * another mutation land in the middle of it.
   *
   * The conditional write ({@link writeFile}'s `expectedContent`) needs that,
   * and so does a caller whose decision spans more than one call: `PUT /file`
   * checks the precondition, plans a creator-access grant that COMMITS, and
   * only then writes, and a save that lands in between would leave that grant
   * behind for a write about to be refused. Such a caller wraps the sequence
   * in a turn and the write inside it takes the same one, re-entrantly.
   *
   * The route's own per-path lock does not establish this: it deliberately
   * runs the op WITHOUT acquiring when the caller already holds the lock, so
   * two requests from that holder would interleave.
   *
   * The reach of the guarantee, exactly: within this process, one mutation at
   * a time per resolved path. ACROSS instances the version-control lock row is the
   * coordinator, and it agrees with this queue only because `PUT /file`
   * canonicalises the path before taking either (see `canonicalRelativePath`);
   * a caller that reaches the service directly with an odd spelling gets the
   * local queue and whatever lock it took itself. Case is not folded: on the
   * Linux deployment target `Foo.md` and `foo.md` are two files, and treating
   * them as one would be a worse bug than the race it would close.
   */
  async withPathTurn<T>(workspaceId: string, wsPath: string, op: () => Promise<T>): Promise<T> {
    const { workspaceDir, relativePath, absolutePath } = await this.resolveInsideRepo(workspaceId, wsPath);
    assertNoGitInternalsSegment(relativePath);
    assertValidPath(relativePath);
    // The resolved check reads the disk, and how long that takes depends on
    // the spelling. Run before the queue, it let a later call overtake an
    // earlier one for the same file; inside the turn, callers keep their order
    // and `op` still never runs on a path that resolves into the git folder.
    return this.withResolvedPathTurn(absolutePath, async () => {
      await assertNotGitInternals(workspaceDir, relativePath, absolutePath);
      return op();
    });
  }

  /**
   * One folder structure change at a time per SUBTREE: an explicit folder
   * delete and the placeholder that keeps an emptied folder. Two turns wait
   * for each other when one folder is, or sits inside, the other, so keeping
   * a folder can never run in the middle of deleting it (and write the
   * placeholder back into a folder whose delete already enumerated its
   * files), and a delete never starts while a folder under it is being kept.
   * Not re-entrant: take it once, and never around another folder's turn.
   *
   * The reach of the guarantee, like {@link withPathTurn}'s: within this
   * process, over this process's clones. Across instances the version-control lock
   * rows coordinate — the placeholder write takes its own path's lock, as the
   * folder delete takes each file's — and each clone's changes meet in git,
   * as any write into a folder another instance deletes already does.
   */
  async withFolderTurn<T>(workspaceId: string, wsDir: string, op: () => Promise<T>): Promise<T> {
    const { relativePath: relativeDir, absolutePath: absoluteDir } = await this.resolveInsideRepo(workspaceId, wsDir);
    assertValidPath(relativeDir);
    const overlaps = (held: string) =>
      held === absoluteDir ||
      held.startsWith(absoluteDir + path.sep) ||
      absoluteDir.startsWith(held + path.sep);
    // Check-and-claim with no await in between, so two callers cannot both
    // find the subtree free.
    for (;;) {
      const waiting = [...this.folderTurns].filter(([held]) => overlaps(held)).map(([, turn]) => turn);
      if (waiting.length === 0) break;
      await Promise.all(waiting);
    }
    let release!: () => void;
    this.folderTurns.set(absoluteDir, new Promise<void>((resolve) => (release = resolve)));
    try {
      return await op();
    } finally {
      this.folderTurns.delete(absoluteDir);
      release();
    }
  }

  /**
   * {@link withPathTurn} on an already-resolved path.
   *
   * A turn this context holds runs through: waiting for itself would hang.
   * What is stored is the SETTLED tail, never the caller's promise, so a
   * throwing mutation cannot wedge the queue behind it and no rejection is
   * left unhandled; the entry is dropped once it is still the tail, so the
   * map does not grow by an entry per file ever touched.
   *
   * Nesting a DIFFERENT file's turn inside one is safe here because the only
   * caller that does it is `PUT /file`, and the grant it seeds is always an
   * `access.md` at or above its target: two such sequences cannot each hold
   * what the other wants, since that would need each target to sit above the
   * other. Every other holder takes one turn and nests nothing.
   */
  private async withResolvedPathTurn<T>(absolutePath: string, op: () => Promise<T>): Promise<T> {
    const held = this.heldTurns.getStore();
    const inner = held?.get(absolutePath);
    if (inner) {
      // Re-entrant: runs without waiting for the turn this context holds —
      // but behind any sibling launched inside that same turn, so a held
      // turn that fires two conditional writes at once cannot have both
      // compare the same old content and then overwrite each other.
      const turn = inner.tail.then(() => op());
      inner.tail = turn.then(
        () => undefined,
        () => undefined,
      );
      return turn;
    }
    const run = (): Promise<T> =>
      this.heldTurns.run(new Map([...(held ?? []), [absolutePath, { tail: Promise.resolve() }]]), op);
    const previous = this.writeTurns.get(absolutePath);
    const turn = previous ? previous.then(run) : run();
    const tail = turn.then(
      () => undefined,
      () => undefined,
    );
    this.writeTurns.set(absolutePath, tail);
    void tail.then(() => {
      if (this.writeTurns.get(absolutePath) === tail) this.writeTurns.delete(absolutePath);
    });
    return turn;
  }

  /**
   * Write one workspace file.
   *
   * - `failIfExists` is an exclusive create (see the `wx` note below).
   * - `expectedContent` is a conditional write: the file must still hold
   *   exactly that text, or the write is refused with a 409. It is what lets
   *   an editor that composed its save from a snapshot (the inline agent
   *   description merges the private comments it read minutes earlier) refuse
   *   rather than erase whatever landed in between. An absent file reads as
   *   the empty string, so `expectedContent: ''` means "expect nothing there
   *   yet" and creates it.
   *
   * The compare and the write run inside this path's write turn, so no other
   * write through this service can land between them, whatever locking the
   * caller did or skipped.
   */
  async writeFile(
    workspaceId: string,
    wsPath: string,
    content: string,
    options?: { failIfExists?: boolean; expectedContent?: string },
  ): Promise<void> {
    const { workspaceDir, relativePath, absolutePath } = await this.resolveInsideRepo(workspaceId, wsPath);
    // A write creates the folders on the way to it, so the reserved root name
    // is refused here too — otherwise `knowledge-base/knowledge-base/x.md`
    // would bring the unreachable folder into existence around the file.
    assertRepoRootNameFree(relativePath, this.kbDirName);
    assertNoGitInternalsSegment(relativePath);
    assertValidPath(relativePath);
    await this.withResolvedPathTurn(absolutePath, async () => {
      // Inside the turn, beside the link check (see `withPathTurn`).
      await assertNotGitInternals(workspaceDir, relativePath, absolutePath);
      await this.assertNotThroughLink(absolutePath, workspaceDir);
      // Compare BEFORE creating anything. The parent chain used to be made
      // first, so a refused save at `x/new-folder/note.md` left an empty
      // `x/new-folder/` behind in everyone's tree — for a write that never
      // happened. The compare reads the file, and an absent file reads as
      // empty whether or not its directory exists.
      if (options?.expectedContent !== undefined) {
        await assertConditionalWriteMatches(absolutePath, relativePath,options.expectedContent);
      }
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      try {
        // `wx` makes create-if-absent ATOMIC at the fs level — an exists-check
        // followed by a plain write would let two concurrent creators (or a
        // stale client whose file list predates the file) both pass the check
        // and silently replace each other's content.
        await fs.writeFile(absolutePath, content, {
          encoding: 'utf-8',
          flag: options?.failIfExists ? 'wx' : 'w',
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          const conflict: Error & { status?: number } = new Error(
            `"${relativePath}" already exists.`,
          );
          conflict.status = 409;
          throw conflict;
        }
        throw err;
      }
      // Inside the turn, so the baseline follows the order the writes landed in.
      await this.diffService?.syncFromDisk(workspaceId, relativePath);
    });
  }

  async createDirectory(workspaceId: string, wsPath: string): Promise<void> {
    const { workspaceDir, relativePath, absolutePath } = await this.resolveInsideRepo(workspaceId, wsPath);
    assertRepoRootNameFree(relativePath, this.kbDirName);
    assertNoGitInternalsSegment(relativePath);
    assertValidPath(relativePath);
    await assertNotGitInternals(workspaceDir, relativePath, absolutePath);
    await this.assertNotThroughLink(absolutePath, workspaceDir);
    await fs.mkdir(absolutePath, { recursive: true });
    const entries = await fs.readdir(absolutePath);
    if (entries.length === 0) {
      await fs.writeFile(path.join(absolutePath, FOLDER_PLACEHOLDER), '', 'utf-8');
    }
  }

  /**
   * Write the empty-folder placeholder into `relativeDir` when that folder
   * exists and holds nothing; true when it wrote one. Unlike
   * {@link createDirectory} it never creates the folder: one that is gone was
   * deleted explicitly and stays gone. A folder reached through a link is
   * refused like any write through one, so the placeholder cannot land
   * outside the workspace.
   */
  async writeFolderPlaceholder(workspaceId: string, wsDir: string): Promise<boolean> {
    const { workspaceDir, relativePath: relativeDir, absolutePath: absoluteDir } =
      await this.resolveInsideRepo(workspaceId, wsDir);
    assertValidPath(relativeDir);
    const placeholder = path.join(absoluteDir, FOLDER_PLACEHOLDER);
    await this.assertNotThroughLink(placeholder, workspaceDir);
    let entries: string[];
    try {
      entries = await fs.readdir(absoluteDir);
    } catch (err) {
      if (isAbsence(err)) return false;
      throw err;
    }
    if (entries.length > 0) return false;
    await fs.writeFile(placeholder, '', { flag: 'wx' });
    return true;
  }

  async writeFileBinary(workspaceId: string, wsPath: string, data: Uint8Array): Promise<void> {
    const { workspaceDir, relativePath, absolutePath } = await this.resolveInsideRepo(workspaceId, wsPath);
    assertRepoRootNameFree(relativePath, this.kbDirName);
    assertNoGitInternalsSegment(relativePath);
    assertValidPath(relativePath);
    // An upload over a path is a mutation of that path, so it takes the same
    // turn as a text write: see {@link withPathTurn}. The whole of it — the
    // parent chain too, so a folder delete serialized before this turn
    // cannot remove the parent between its creation and the write.
    await this.withResolvedPathTurn(absolutePath, async () => {
      await assertNotGitInternals(workspaceDir, relativePath, absolutePath);
      await this.assertNotThroughLink(absolutePath, workspaceDir);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, data);
      await this.diffService?.syncFromDisk(workspaceId, relativePath);
    });
  }

  /**
   * Extract a `.zip` file already present in the workspace into a destination
   * directory (defaults to the archive's parent directory — "unzip here").
   *
   * Before a byte of the archive is read, the judge's `archive` is asked
   * whether the caller may read it, and its refusal is the answer: nothing
   * is written and no entry is named.
   *
   * Every entry is judged first and nothing is written while it is: the
   * archive's plan (`planZipEntries`: the entry rules and the zip-bomb caps,
   * `ONE_COMMIT_LIMITS`), the guards below on what is on disk at each target,
   * and the `judge`'s `entry`. The files that pass are then handed to
   * `landing` in ONE call, and the directory entries that pass are created
   * after it returns. With `LockingFilesystem` as the landing, the files that
   * pass land as one commit: an archive's own `access.md` and the files beside
   * it arrive together. A file whose lock the lock's own gates refuse is
   * skipped through the judge's `refusedAtLock`.
   *
   * Every entry that will not land, whatever the reason, is put to the
   * judge's `skipped` (macOS metadata aside, which the plan drops without
   * counting or reporting it), and one that decides the archive refuses it
   * whole (`ArchiveRefusedError`) with nothing written. A
   * landing refused because
   * another holds one of its paths' locks is answered as a 409 naming that
   * path, and no directory entry is created. A landing whose commit landed
   * but whose push needs resolution (`PushNeedsAgentResolutionError`) has its
   * directory entries created and its files synced before that error goes on
   * to the caller: the files are committed, only their sharing is pending.
   *
   * The files' bytes are all held in memory until they land: at most
   * `ONE_COMMIT_MAX_TOTAL_BYTES` of entries, besides the archive itself.
   */
  async unzipFile(
    workspaceId: string,
    zipWsPath: string,
    destDirWsPath: string | undefined,
    /**
     * How the archive's read and each entry are judged (see {@link ArchiveEntryJudge}); without one, the
     * archive's read is not checked and every entry the guards below pass lands. Both unzip doors pass one.
     */
    judge: ArchiveEntryJudge | undefined,
    /** Where the files land: one call, for every file that passed. */
    landing: ArchiveLanding,
  ): Promise<UnzipResult> {
    // The checks about the archive and the destination that read the disk at
    // their resolved paths (the git folder they resolve into, a link on the
    // way) come after the judge's question about each: what is on disk at a
    // path the caller may not read is not theirs to learn from the answer.
    // `resolveInsideRepo` still applies the git rule to the raw spelling
    // first (see there), so that rule, not the normaliser, answers a git path
    // spelled oddly.
    const { workspaceDir, relativePath: zipRelativePath, absolutePath: zipAbsolute } =
      await this.resolveInsideRepo(workspaceId, zipWsPath);
    assertNoGitInternalsSegment(zipRelativePath);
    if (!zipRelativePath.toLowerCase().endsWith('.zip')) {
      throw new VersionControlValidationError('Only .zip files can be extracted');
    }
    // Extracting an archive reads it: one the caller may not read is refused
    // before its bytes, or the disk at its resolved path, are looked at.
    await judge?.archive(zipRelativePath);
    await assertNotGitInternals(workspaceDir, zipRelativePath, zipAbsolute);
    // Inferred from the NORMALISED archive path, so an archive named without
    // the prefix extracts beside itself inside the repository rather than at
    // the workspace root.
    const { relativePath: destRel, absolutePath: destAbsolute } =
      await this.resolveInsideRepo(workspaceId, destDirWsPath ?? path.posix.dirname(zipRelativePath));
    assertValidPath(destRel);
    assertNoGitInternalsSegment(destRel);
    await judge?.destination(destRel);
    await assertNotGitInternals(workspaceDir, destRel, destAbsolute);
    // Neither the archive nor the destination may sit behind a link; each
    // entry's own target is checked under its lock, below.
    await this.assertNotThroughLink(zipAbsolute, workspaceDir);
    if (destAbsolute !== this.repoRoot(workspaceDir)) await this.assertNotThroughLink(destAbsolute, workspaceDir);

    // The archive is READ ONCE, here, and the reader is handed those bytes —
    // it is never given the path to open for itself. Two reasons, and the
    // first is why this is not a `stat` followed by `new AdmZip(path)`:
    //
    //  - The zip reader cannot tell absence from corruption. On a path with
    //    nothing at it `AdmZip` throws "ADM-ZIP: Invalid filename", which would
    //    be dressed up as an unreadable archive (422) and blame the bytes for
    //    a name that never existed. Only the read knows which it was.
    //  - A separate probe answers about a DIFFERENT moment than the open. An
    //    archive deleted in between passed the probe and then failed the open,
    //    and the caller got the 422 the probe existed to prevent. One read is
    //    one moment, so there is no in-between to lose.
    //
    // `AdmZip` from a buffer costs nothing extra: given a path it reads the
    // whole file in anyway.
    let zipBytes: Buffer;
    try {
      zipBytes = await fs.readFile(zipAbsolute);
    } catch (err) {
      if (isAbsence(err)) throw new PathNotFoundError(zipRelativePath);
      throw err;
    }

    let zip: AdmZip;
    try {
      zip = new AdmZip(zipBytes);
    } catch (err) {
      throw new UnreadableArchiveError(err instanceof Error ? err.message : String(err));
    }

    // The destination directory is created by the landing, with the first
    // file under it, or by a directory entry. Creating it up front would
    // leave it behind even when every entry is write-blocked.
    const extracted: string[] = [];
    const skipped: UnzipResult['skipped'] = [];
    const writes: { path: string; content: Buffer }[] = [];
    /** The name in the archive of each file handed to the landing, for the report. */
    const entryNameAt = new Map<string, string>();
    /** Files the landing dropped because the lock's gates refused their lock. */
    const refusedAtLock = new Set<string>();
    const directories: { name: string; absolute: string }[] = [];
    const destination = path.relative(workspaceDir, destAbsolute).replace(/\\/g, '/');

    /**
     * Record that the entry named `name` in the archive will not land, and
     * why — unless the judge says that entry decides the whole archive, which
     * then refuses the extraction before anything is written. `wsPath` is
     * where the entry would have landed, or null when its name gives it none.
     */
    const skip = (name: string, wsPath: string | null, why: unknown): void => {
      const whole = judge?.skipped(wsPath, name, why);
      if (whole) throw whole;
      skipped.push({ path: name, reason: why instanceof Error ? why.message : String(why) });
    };

    // The archive's plan is `zip-entry-rules`' (`planZipEntries`), so
    // `apply_file_upload` lands the same archive by the same plan rather than
    // by a second copy of it. A directory entry is created below; a file
    // marked `duplicate` lands like any other, in the same batch.
    for (const step of planZipEntries(zip, destination, ONE_COMMIT_LIMITS)) {
      if (step.kind === 'skip') {
        skip(step.name, step.target, unzipSkipReason(step));
        continue;
      }
      // An entry the judge refuses is skipped, not extracted, so an archive
      // can't be a way around whatever the judge enforces. Every entry is
      // judged before anything is written, so a refused entry leaves nothing
      // behind on disk.
      const allowEntry = async (kind: 'file' | 'dir'): Promise<boolean> => {
        if (!judge) return true;
        try {
          await judge.entry(step.target, kind);
          return true;
        } catch (err) {
          if (err instanceof ArchiveRefusedError) throw err;
          skip(step.name, step.target, err instanceof Error ? err : 'Refused before it was written');
          return false;
        }
      };

      // What is on disk at and above an entry's target (a link on the way,
      // the git folder) is asked only once the entry's own gates have let it
      // through: a directory entry's here, after the judge; a file's under
      // its lock, in the landing's check below.
      if (step.kind === 'dir') {
        if (!(await allowEntry('dir'))) continue;
        const obstacle = await landingObstacle(workspaceDir, this.kbDirName, step.target);
        if (obstacle !== null) {
          skip(step.name, step.target, obstacleRefusal(obstacle));
          continue;
        }
        // The plan's target is the destination plus the entry's own path.
        directories.push({ name: step.name, absolute: path.resolve(destAbsolute, step.target.slice(destination.length + 1)) });
        continue;
      }

      if (!(await allowEntry('file'))) continue;
      writes.push({ path: step.target, content: step.data });
      entryNameAt.set(step.target, step.name);
      extracted.push(step.target);
    }

    // A file the lock's gates refuse is the judge's to answer for: skipped,
    // or the whole extraction refused (the landing then gives back every lock
    // with nothing written).
    const refused = judge
      ? (wsPath: string, err: unknown): void => {
          judge.refusedAtLock(wsPath, err);
          skip(entryNameAt.get(wsPath) ?? wsPath, wsPath, err);
          refusedAtLock.add(wsPath);
        }
      : undefined;
    // Each file's landing target, asked with every lock held and after the
    // lock's gates (see the directory entries above): a file that meets a
    // link or the git folder is skipped, or refuses the extraction when the
    // judge says so, and is never written.
    const obstructed = new Set<string>();
    const targetCheck = async (
      pending: readonly { path: string; content: Buffer }[],
    ): Promise<{ path: string; content: Buffer }[]> => {
      const kept: { path: string; content: Buffer }[] = [];
      for (const write of pending) {
        const obstacle = await landingObstacle(workspaceDir, this.kbDirName, write.path);
        if (obstacle === null) {
          kept.push(write);
          continue;
        }
        skip(entryNameAt.get(write.path) ?? write.path, write.path, obstacleRefusal(obstacle));
        obstructed.add(write.path);
      }
      return kept;
    };
    let sharingPending: PushNeedsAgentResolutionError | undefined;
    // In the destination folder's turn, which `delete_folder` takes over the
    // same subtree: a folder delete running between the landing creating the
    // destination and its commit would remove the folder the files are
    // landing in (see `apply_file_upload`, which lands the same way).
    await this.withFolderTurn(workspaceId, destRel, async () => {
      if (writes.length > 0) {
        try {
          await landing.writeFiles(
            writes,
            `Extract ${zipRelativePath} (${writes.length} file${writes.length === 1 ? '' : 's'})`,
            [],
            targetCheck,
            refused,
          );
        } catch (err) {
          if (err instanceof PathHeldError) throw extractionHeldRefusal(err);
          if (!(err instanceof PushNeedsAgentResolutionError)) throw err;
          // Committed; only the push needs help. The rest of the extraction
          // happens as it would have, and the caller is told after.
          sharingPending = err;
        }
      }
      // Past the commit nothing may throw: the files have landed, and the
      // caller is owed the answer, the sync and the tree event. A directory
      // entry that cannot be created (a file already sits at its path) is a
      // skipped entry, reported without a server path.
      for (const dir of directories) {
        try {
          await fs.mkdir(dir.absolute, { recursive: true });
        } catch (err) {
          const code = (err as { code?: unknown }).code;
          if (code !== 'EEXIST' && code !== 'ENOTDIR') log.warn(`could not create a folder an archive carries:`, { err });
          skipped.push({
            path: dir.name,
            reason: code === 'EEXIST' || code === 'ENOTDIR' ? 'A file is already at this path, so the folder was not created' : 'The folder could not be created',
          });
        }
      }
    });
    const landed = extracted.filter((p) => !refusedAtLock.has(p) && !obstructed.has(p));
    for (const written of new Set(landed)) await this.diffService?.syncFromDisk(workspaceId, written);
    if (sharingPending) throw sharingPending;

    return {
      destination: destination || '.',
      extracted: landed,
      skipped,
    };
  }

  async getWorkspacePath(workspaceId: string): Promise<string> {
    return this.resolveWorkspaceDir(workspaceId);
  }

  /**
   * True when `workspaceId` already has a bootstrapped clone — either in the
   * in-process cache or persisted on disk — WITHOUT triggering the lazy
   * bootstrap that `resolveWorkspaceDir` does. Lets best-effort callers
   * (e.g. chat-upload staging) refuse to clone an arbitrary branch supplied
   * in a request body. Per-branch access itself is open by design, so this is
   * an IO guard, not an ownership check.
   */
  async hasBootstrappedWorkspace(workspaceId: string): Promise<boolean> {
    if (!workspaceId) return false;
    let branch: string;
    try {
      branch = branchForWorkspaceId(workspaceId);
    } catch {
      return false;
    }
    if (this.branchDirs.has(branch)) return true;
    let workspaceDir: string;
    try {
      workspaceDir = this.workspaceDirWithinRoot(workspaceId);
    } catch {
      return false;
    }
    return this.hasWorkingCopy(path.join(workspaceDir, this.kbDirName)).catch(() => false);
  }

  /**
   * Enumerate every branch this process has bootstrapped a workspace for.
   * Used by the `PendingCommitsWorker` to know which workspaces to poll
   * and by `startupReconcile` to know which workspaces to scan for
   * orphan files. The returned descriptors match the worker's
   * `WorkspaceProvider` contract — id + branch in one struct, no need
   * for the caller to re-encode.
   *
   * The cache is populated lazily as `getOrCreateForBranch` resolves, so
   * a freshly-touched branch shows up here within the same poll cycle
   * that resolved its bootstrap.
   */
  knownWorkspaces(): Array<{ id: string; branch: string }> {
    return Array.from(this.branchDirs.keys()).map((branch) => ({
      id: workspaceIdForBranch(branch),
      branch,
    }));
  }

  /**
   * Walk the working tree of `workspaceId`'s clone and return every
   * path `git status --porcelain=v1` reports as dirty (untracked,
   * modified, or staged). Used by `PendingCommitsService.startupReconcile`
   * to enqueue commits for files left orphaned by a prior process
   * crash — under save=share + the pending-commits queue the working
   * tree should never be dirty in steady state, so anything reported
   * here is recovery material.
   *
   * Paths are workspace-relative (`<kbDirName>/<repo-relative>`), matching
   * the form `releaseLock` expects.
   *
   * Returns an empty array if the workspace dir isn't yet bootstrapped
   * or the repo dir is missing; the worker treats that as "nothing to
   * recover here" and moves on.
   */
  async scanOrphanedPaths(
    workspaceId: string,
  ): Promise<Array<{ path: string }>> {
    let repoDir: string;
    try {
      const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
      repoDir = path.join(workspaceDir, this.kbDirName);
      // Confirm the inner repo dir actually exists — getOrCreateForBranch
      // may have failed mid-bootstrap and we'd otherwise hit a confusing
      // git error here.
      await fs.access(path.join(repoDir, '.git'));
    } catch {
      return [];
    }
    let stdout: string;
    try {
      ({ stdout } = await this.gitRunner.run(repoDir, ['status', '--porcelain=v1', '-z']));
    } catch (err) {
      log.warn(`orphan scan via git status failed for ${workspaceId}:`, { err });
      return [];
    }
    if (!stdout.trim()) return [];
    // `-z` separates entries with NUL and skips quoting; renames use a
    // second NUL-terminated field for the original path which we ignore.
    const entries = stdout.split('\0').filter((s) => s.length > 0);
    const out: Array<{ path: string }> = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      // First 3 chars are status codes; the rest is the path.
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const repoRelative = entry.slice(3);
      // Renames + copies carry the original path as the next NUL-separated
      // field. Skip it — we want the new path only.
      if (code[0] === 'R' || code[0] === 'C') {
        i += 1;
      }
      out.push({ path: `${this.kbDirName}/${repoRelative}` });
    }
    return out;
  }

  /**
   * Remove on-disk workspace dirs whose branches aren't in `knownBranches`.
   * Handles two drift sources:
   *   - Branch deleted on origin while the backend was offline (no live
   *     `deleteBranch` call ran, so the clone wasn't cleaned up).
   *   - Local-only experimentation (a branch that never made it to origin).
   *
   * `knownBranches` is the set of branch names the caller considers
   * authoritative — typically the union of local + remote branches from
   * a recent `git for-each-ref` against one of the live clones.
   *
   * Best-effort: removal failures are logged and swallowed so one stuck
   * directory doesn't poison the whole sweep. Returns the set of removed
   * workspace ids so callers can log / report cleanup activity.
   */
  async sweepOrphanedWorkspaces(
    knownBranches: Iterable<string>,
  ): Promise<{ removed: string[] }> {
    const validIds = new Set<string>();
    for (const b of knownBranches) validIds.add(workspaceIdForBranch(b));

    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(this.workspacesRoot, { withFileTypes: true });
    } catch {
      return { removed: [] };
    }

    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (validIds.has(entry.name)) continue;
      // Skip dirs that don't look like an encoded workspace id — third-
      // party tooling sometimes drops scratch dirs alongside ours.
      try {
        decodeURIComponent(entry.name);
      } catch {
        continue;
      }
      const dir = path.join(this.workspacesRoot, entry.name);
      try {
        await fs.rm(dir, { recursive: true, force: true });
        this.branchDirs.delete(branchForWorkspaceId(entry.name));
        removed.push(entry.name);
      } catch (err) {
        log.warn(`sweep failed for ${entry.name}:`, { err });
      }
    }
    // The repository is not under the root, so the sweep never touched it.
    // What it forgets is the worktrees whose folders went, and their
    // branches' local refs, as removing a clone took its branch with it.
    if (removed.length > 0) {
      await this.repository
        .forgetWorktrees(removed.map((id) => branchForWorkspaceId(id)))
        .catch((err: unknown) => log.warn('could not prune the swept worktrees from the repository:', { err }));
    }
    return { removed };
  }

  /**
   * Resolve a workspace id to its on-disk directory. `workspaceId` is
   * `encodeURIComponent(branch)` — the decoded branch is the in-memory
   * cache key, the encoded form is the disk directory name.
   *
   * Resolution order:
   *   1. In-process cache (`branchDirs`) — bootstrap completed earlier this
   *      run, or a prior `resolveWorkspaceDir` populated it from disk.
   *   2. On-disk lookup — the directory may persist across container
   *      restarts; if `<id>/<kbDirName>/.git` is there, register and return.
   *   3. **Lazy bootstrap** — clone the branch on demand via
   *      `getOrCreateForBranch`. Without this, any frontend route that
   *      hits `/api/workspace/:id/workflow/...` for a branch the user
   *      hasn't explicitly bootstrapped via `GET /api/workspace?branch=…`
   *      would 500 with "Invalid workspace ID" (real symptom in dev:
   *      `listBranches` / `branch-status` failing right after container
   *      start because the frontend's parallel calls race the initial
   *      bootstrap). Bootstrap is single-flight so concurrent racers
   *      share one clone. A bogus branch name surfaces the underlying
   *      `BranchNameError` / clone failure verbatim — much more useful
   *      than the old generic "Invalid workspace ID".
   *
   * Cold-cache cost: a mid-request clone is multi-second. Subsequent
   * requests use the cache. Acceptable since it only happens once per
   * branch per container lifetime.
   */
  /**
   * Resolve `<workspacesRoot>/<workspaceId>` and assert it stays under the
   * root. `workspaceId` is expected to be `encodeURIComponent(branch)`, but a
   * malformed caller value (e.g. `..`) could otherwise escape the root before
   * the `.git` probe runs. Mirrors `clearTmp`'s containment guard.
   */
  private workspaceDirWithinRoot(workspaceId: string): string {
    const root = path.resolve(this.workspacesRoot);
    const dir = path.resolve(root, workspaceId);
    if (dir !== root && !dir.startsWith(root + path.sep)) {
      throw new Error(`Invalid workspace ID "${workspaceId}": path escapes the workspaces root.`);
    }
    return dir;
  }

  private async resolveWorkspaceDir(workspaceId: string): Promise<string> {
    if (!workspaceId) throw new Error('Invalid workspace ID');
    const branch = branchForWorkspaceId(workspaceId);
    if (this.branchDirs.has(branch)) {
      return this.branchDirs.get(branch)!;
    }
    // Wait for any in-flight bootstrap before trusting the on-disk check.
    // `git clone` creates `.git` early in a multi-second clone, before the
    // working tree files (roles.yaml, etc.) are checked out — so a naive
    // fs.access(.git) on a mid-clone dir returns "ready" and the caller's
    // next readFile faceplants with ENOENT and a 500. Mirrors the
    // single-flight wait inside `getOrCreateForBranch`.
    await this.awaitBootstrapOrEvict(branch).catch(() => undefined);
    if (this.branchDirs.has(branch)) {
      return this.branchDirs.get(branch)!;
    }
    const workspaceDir = this.workspaceDirWithinRoot(workspaceId);
    // A worktree whose link to the repository is broken falls through too:
    // the bootstrap recreates it.
    if (await this.hasWorkingCopy(path.join(workspaceDir, this.kbDirName)).catch(() => false)) {
      this.registerBranchDir(branch, workspaceDir);
      return workspaceDir;
    }
    try {
      await this.getOrCreateForBranch(branch);
      const dir = this.branchDirs.get(branch);
      if (dir) return dir;
      // Bootstrap reported success but didn't register — defensive fallback.
      return workspaceDir;
    } catch (err) {
      // Domain errors pass through intact: they carry the status the routes
      // map (BranchNameError → 400), which is how a malformed or bogus
      // workspace id stays a client error instead of the wrap below erasing
      // the type and surfacing as a 500. A malformed id (bad percent-escape)
      // decodes to itself, and `%` never passes the branch-name rules, so it
      // lands here as a BranchNameError like any other invalid name.
      if (err instanceof VersionControlDomainError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid workspace ID "${workspaceId}": ${reason}`);
    }
  }

  /**
   * The tree of the folder at `root`, with paths relative to `workspaceRoot`.
   * `ignore` are the `.bevelignore` rules in force above `root` (none for a
   * walk from the workspace's top).
   */
  private async buildFileTree(
    root: string,
    workspaceRoot: string,
    readFilter?: ReadTreeFilter,
    ignore?: IgnoreRules,
  ): Promise<FileTreeEntry> {
    /** A folder while the tree is built: whether the caller may read it decides, once its subtree is known, whether it stays. */
    interface DirNode {
      name: string;
      relativePath: string;
      readable: boolean;
      children: (FileTreeEntry | DirNode)[];
      /**
       * Files directly in it the caller's read rules kept out — counted, never
       * named. Only an entry the filter judged unreadable counts:
       * `.bevelignore`d and `.git` entries never reach it. Folders dropped
       * below it are added in `finish`.
       */
      withheld: number;
    }
    const relOf = (abs: string) => path.relative(workspaceRoot, abs).replace(/\\/g, '/');
    const top: DirNode = { name: path.basename(root), relativePath: relOf(root) || '.', readable: true, children: [], withheld: 0 };
    const nodes = new Map<string, DirNode>([['', top]]);
    const walk: TreeWalkOptions = { ...explorerWalk(), ...(ignore ? { ignore } : {}) };

    await this.disk.walk(root, walk, [
      {
        async onDir(rel, entries) {
          const node = nodes.get(rel)!;
          const abs = path.join(root, rel);
          const rels = entries.map((e) => relOf(path.join(abs, e.name)));
          // Read-permission filter: ONE batched check per directory. Drops files the
          // caller can't read. A directory is kept when the caller can read it — a
          // readable directory left empty after filtering stays visible, the folder
          // itself is readable — OR when something readable survives beneath it: a
          // grant below (a linked skill's folder opened to a plugin's readers, a
          // sub-folder shared on its own) makes the folders above it the way there,
          // shown as containers whose own contents stay filtered. So an unreadable
          // directory is walked, not skipped, and dropped only when the walk finds
          // nothing (see `finish`). Fail-closed: anything not explicitly readable is
          // dropped. No filter → identical to the pre-feature tree (regression-safe).
          const verdict = readFilter && entries.length > 0 ? await readFilter(rels) : null;
          const readable = (rel: string) => verdict === null || verdict.get(rel) === true;
          entries.forEach((entry, i) => {
            const entryRel = rels[i]!;
            if (entry.isDirectory()) {
              const child: DirNode = {
                name: entry.name,
                relativePath: entryRel,
                readable: readable(entryRel),
                children: [],
                withheld: 0,
              };
              nodes.set(rel ? `${rel}/${entry.name}` : entry.name, child);
              node.children.push(child);
            } else if (readable(entryRel)) {
              node.children.push({ name: entry.name, relativePath: entryRel, type: 'file' });
            } else {
              node.withheld++;
            }
          });
        },
      },
    ]);

    /**
     * Bottom-up: drop a folder the caller may not read once nothing readable
     * turned up beneath it; sort each level. Each folder that stays carries
     * how many entries were withheld anywhere under it (a dropped folder
     * counts as one, its own subtree's count included), so a tree drawn from
     * ONE folder — the Library's, a delete's — can tell "empty" from "kept
     * from you" for that folder rather than for the listing. Only when
     * something was withheld, so an unfiltered — or all-readable — listing
     * stays exactly the tree it always was.
     */
    const finish = (node: DirNode): FileTreeEntry => {
      const children: FileTreeEntry[] = [];
      let withheld = node.withheld;
      for (const child of node.children) {
        if ('type' in child) {
          children.push(child);
          continue;
        }
        const sub = finish(child);
        withheld += sub.withheld ?? 0;
        if (child.readable || (sub.children?.length ?? 0) > 0) children.push(sub);
        else withheld++;
      }
      children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const entry: FileTreeEntry = { name: node.name, relativePath: node.relativePath, type: 'directory', children };
      return withheld > 0 ? { ...entry, withheld } : entry;
    };
    return finish(top);
  }
}

/**
 * The `.bevelignore` rules in force ABOVE the folder `inRepo` (repository-
 * relative, `''` for the root) — the root's file and every ancestor's, not
 * the folder's own, which a walk from the folder layers itself — or null when
 * one of those rules hides the folder or an ancestor, as the explorer's walk
 * from the root would never enter it.
 */
async function ignoreRulesAbove(repoRoot: string, inRepo: string): Promise<IgnoreRules | null> {
  let rules: IgnoreRules = BevelIgnoreStack.empty();
  let dir = repoRoot;
  for (const segment of inRepo.split('/').filter(Boolean)) {
    rules = await rules.extendedWith(dir);
    dir = path.join(dir, segment);
    if (rules.isIgnored(dir, true)) return null;
  }
  return rules;
}

/**
 * The explorer's walk of a workspace: no git internals (never user content,
 * and listing it would blow up the tree), no `.gitkeep` (the empty-folder
 * placeholder, not worth showing), `.bevelignore` honoured on the way down —
 * and a folder that cannot be listed is the request's error, not a tree with
 * a silent gap. A folder download and the whole-KB read walk the same way,
 * so they carry exactly what the explorer shows.
 */
function explorerWalk(): TreeWalkOptions {
  return {
    // Any spelling of the git folder (`.GIT`, `.git.`) — the same rule the path
    // guards apply, so a download or listing never carries what they refuse —
    // and the empty-folder placeholder, which is never content.
    skip: (e) => hasGitInternalsSegment(e.name) || (isFolderPlaceholder(e.name) && e.isFile()),
    ignore: true,
    unreadable: 'throw',
  };
}
