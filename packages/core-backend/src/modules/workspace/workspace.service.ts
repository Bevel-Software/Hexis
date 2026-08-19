import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import type { AuthUser, IWorkspaceService, WorkspaceInfo, FileTreeEntry } from '@bevel-software/platform-shared';
import { assertValidRelativePath, validateFilename, DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { BevelIgnoreStack } from './bevel-ignore.js';
import { workspaceIdForBranch, branchForWorkspaceId } from '../../shared/workspace-id.js';
import { assertValidBranchName } from '../kb-fs/branch-name.js';
import { cloneTrackingConfigArgs, SAFE_IMPLICIT_FETCH_ARGS } from '../kb-fs/clone-config.js';
import type { IDiffService } from '../diff/diff.interface.js';

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
 *       knowledge-base/           # the git clone checked out to <branch>
 *
 * Bootstrap is lazy: the first call to `getOrCreateForBranch(branch)` clones
 * the repo with `-b <branch>`. Subsequent callers — whether the same user or
 * a different one — share the same directory and the same git operations are
 * serialised through the workspace mutex elsewhere in the codebase.
 */

export interface UnzipResult {
  /** Workspace-relative directory the archive was extracted into. */
  destination: string;
  /** Workspace-relative paths of files that were written. */
  extracted: string[];
  /** Workspace-relative entry paths from the archive that were intentionally skipped (e.g. macOS metadata, invalid names). */
  skipped: { path: string; reason: string }[];
}

// Zip-bomb guardrails. The upload cap is 50 MB compressed; even a generous
// 100× expansion ratio still fits inside these limits, so a well-behaved
// archive will never trip them. They exist so a hostile or malformed zip
// can't run the container out of disk by inflating to gigabytes.
const UNZIP_MAX_ENTRIES = 10_000;
const UNZIP_MAX_ENTRY_BYTES = 100 * 1024 * 1024; // 100 MB per file
const UNZIP_MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB across the whole archive

// Folder-download cap. The whole zip is built in memory by adm-zip (no
// streaming) so the cap also bounds peak heap usage for one download.
// Reuses the unzip total as a single "fits in a workspace" budget.
const ZIP_DOWNLOAD_MAX_BYTES = UNZIP_MAX_TOTAL_BYTES;

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

const execFileAsync = promisify(execFile);

/**
 * Identity stamped on the per-branch clone's git config. Every workflow
 * commit overrides this with `--author=…` so the human shows up in
 * `git log`; this is just the fallback committer identity so plain
 * git operations have something to attribute to.
 */
const BOT_NAME = 'Bevel Workflow';
const BOT_EMAIL = 'bevel-workflow@bevel.software';

/** Redact any token that might leak into an error message. */
function redactError(err: unknown): string {
  const token = process.env.GITHUB_TOKEN;
  const msg = err instanceof Error ? err.message : String(err);
  return token ? msg.replaceAll(token, '***') : msg;
}

const FETCH_CACHE_TTL_MS = 30_000;

/**
 * Per-directory read filter for the file tree. Given a batch of
 * workspace-relative entry paths (e.g. `staging-repo/Product/Knowledge/x.md`),
 * returns a verdict map keyed by those paths (`path → readable`). Injected by
 * the route from the access service so `WorkspaceService` stays access-agnostic
 * (it gets a function, not the access module). See `modules/access/kb-read-filter.ts`.
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
  private readonly inFlightFetches = new Map<string, Promise<void>>();

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
    private readonly kbDirName: string,
    gitUsername: string | (() => string) = 'x-access-token',
  ) {
    this.kbRepoUrl = typeof kbRepoUrl === 'function' ? kbRepoUrl : () => kbRepoUrl;
    this.gitUsername = typeof gitUsername === 'function' ? gitUsername : () => gitUsername;
  }

  private readonly kbRepoUrl: () => string;
  private readonly gitUsername: () => string;

  setDiffService(diffService: IDiffService): void {
    this.diffService = diffService;
  }

  setWorkspaceClonedListener(listener: (workspaceId: string) => void): void {
    this.onWorkspaceCloned = listener;
  }

  /** Build git clone args that inject credentials via -c headers so the token never appears in the repo URL. */
  private gitCloneArgs(targetDir: string, branch: string, referenceRepo?: string): string[] {
    const token = process.env.GITHUB_TOKEN;
    // core.longpaths=true: KB has paths >260 chars; without this the clone silently drops those files on Windows.
    const args = ['clone', '-c', 'core.longpaths=true', '-b', branch];
    // Borrow the object database of an existing sibling clone. Every commit
    // in the KB is already on disk locally, so object transfer drops to
    // ~zero and a cold branch switch pays only the ref-negotiation
    // round-trip instead of a full download. `--dissociate` copies the
    // borrowed objects into the new repo and drops the alternates link, so
    // the new clone stays independent even if the sibling is later swept
    // or gc'd. Still a real clone of the real remote — all `refs/remotes/
    // origin/*` are populated as usual.
    if (referenceRepo) {
      args.push('--reference', referenceRepo, '--dissociate');
    }
    if (token) {
      // The helper script reads from GITHUB_TOKEN at runtime — the token value never appears in args.
      // Username is provider-specific (GitHub `x-access-token`, GitLab `oauth2`, …); the token is
      // always the Basic-auth password, which every major host accepts.
      args.push(
        '-c', `credential.helper=!f() { echo "username=${this.gitUsername()}"; echo "password=$GITHUB_TOKEN"; }; f`,
      );
    }
    args.push(this.kbRepoUrl(), targetDir);
    return args;
  }

  /**
   * Find an existing workspace clone on disk to use as a `--reference` for
   * a new clone. Any clone of the KB works — they all share the same object
   * history. Returns the absolute path to the inner repo dir, or null when
   * no sibling exists (the first branch after a cold start). Scans disk
   * rather than the in-memory `branchDirs` map so clones that survived a
   * process restart are still found.
   */
  private async findSiblingRepo(excludeBranch: string): Promise<string | null> {
    const excludeId = workspaceIdForBranch(excludeBranch);
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(this.workspacesRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === excludeId) continue;
      const repoDir = path.join(this.workspacesRoot, entry.name, this.kbDirName);
      try {
        await fs.access(path.join(repoDir, '.git'));
        return repoDir;
      } catch {
        // No `.git` — half-built or unrelated dir; keep looking.
      }
    }
    return null;
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
      try {
        await fs.access(path.join(this.workspacesRoot, entry.name, this.kbDirName, '.git'));
        return entry.name;
      } catch {
        // No `.git` — half-built or unrelated dir; keep looking.
      }
    }
    return null;
  }

  /**
   * Run the clone. When a `referenceRepo` is supplied and the referenced
   * clone fails (e.g. the sibling's object store is corrupt or mid-write),
   * fall back once to a plain network clone so a bad sibling can never
   * block a new branch from bootstrapping.
   */
  private async runClone(
    targetDir: string,
    branch: string,
    referenceRepo: string | null,
  ): Promise<void> {
    if (referenceRepo) {
      try {
        await execFileAsync('git', this.gitCloneArgs(targetDir, branch, referenceRepo), {
          env: { ...process.env },
        });
        return;
      } catch (err) {
        console.warn(
          `[workspace] referenced clone for "${branch}" failed, retrying without reference:`,
          redactError(err),
        );
        // Clear any partial output so the retry clones into a clean dir.
        await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    await execFileAsync('git', this.gitCloneArgs(targetDir, branch), {
      env: { ...process.env },
    });
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
      return this.buildWorkspaceInfo(branch, workspaceDir);
    }

    // Check disk — the clone may have been bootstrapped by a previous
    // process and survived a restart.
    try {
      await fs.access(path.join(repoDir, '.git'));
      // Migration for clones already on disk: re-stamp the tracking config the
      // first time this process opens them, so a clone whose config drifted
      // (duplicate fetch refspec / merge ref) is repaired before anything
      // pulls it. Once per branch per process — the cached paths above return
      // before reaching here.
      await this.normalizeCloneTracking(repoDir, branch);
      this.branchDirs.set(branch, workspaceDir);
      return this.buildWorkspaceInfo(branch, workspaceDir);
    } catch {
      // Not on disk — bootstrap below.
    }

    // Single-flight bootstrap. Concurrent callers for the same branch
    // share the first one's promise instead of stacking clones.
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
      this.branchDirs.set(branch, workspaceDir);
      return this.buildWorkspaceInfo(branch, workspaceDir);
    }
    this.inFlightBootstraps.set(branch, bootstrap);

    try {
      // A clone with `-b <branch>` against a never-seeded remote fails
      // naturally; seeding the remote is the KB startup phase's job, at boot.
      await fs.mkdir(workspaceDir, { recursive: true });
      await this.cloneProcessMapForBranch(workspaceDir, branch);
      this.branchDirs.set(branch, workspaceDir);
      resolveBootstrap();
    } catch (err) {
      this.branchDirs.delete(branch);
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
    return this.getOrCreateForBranch(branch ?? DEFAULT_BRANCH);
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
   * Collapse the clone's tracking config to a single fetch refspec and a single
   * upstream ref for `branch` (see `kb-fs/clone-config.ts`). A clone that
   * accumulated a second `remote.origin.fetch` refspec or `branch.<b>.merge`
   * value makes git refuse to refresh it — "Cannot rebase onto multiple
   * branches" — which is how a post-merge pull of the target branch fails.
   *
   * Never throws: it only ever touches `.git/config`, so a failure leaves the
   * workspace exactly as usable as it was, and the git layer self-heals the
   * same keys before it pulls.
   */
  private async normalizeCloneTracking(repoDir: string, branch: string): Promise<void> {
    try {
      for (const args of cloneTrackingConfigArgs(branch)) {
        await execFileAsync('git', ['-C', repoDir, ...args]);
      }
    } catch (err) {
      // One line per branch, not per key: every key writes to the same
      // `.git/config`, so what fails for one fails for all.
      console.warn(
        `[workspace] could not normalize the tracking config of the "${branch}" clone:`,
        redactError(err),
      );
    }
  }

  private async cloneProcessMapForBranch(workspaceDir: string, branch: string): Promise<void> {
    const targetDir = path.join(workspaceDir, this.kbDirName);

    // Probe whether `targetDir` exists. We split the existence check from
    // the inner `.git` validation so unexpected errors from EITHER probe
    // propagate to the caller instead of getting silently swallowed by an
    // outer catch (the previous shape let an inner rethrow fall through
    // to a clone-into-non-empty-dir, producing a confusing 500).
    let targetExists = true;
    try {
      await fs.access(targetDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        targetExists = false;
      } else {
        throw err;
      }
    }

    if (targetExists) {
      // The directory exists, but a previous bootstrap may have crashed
      // mid-clone — leaving a directory shell without `.git`. Treat
      // anything missing `.git` as not-cloned and re-clone. (Can't be
      // an active workspace either: every cloned repo has `.git` from
      // step one.)
      let alreadyCloned = false;
      try {
        const dotGit = await fs.stat(path.join(targetDir, '.git'));
        if (dotGit.isDirectory() || dotGit.isFile()) {
          alreadyCloned = true;
        }
      } catch (err) {
        // Only treat "does-not-exist" as "half-built dir, wipe and
        // re-clone". A transient EACCES / EIO / EBUSY must NOT delete
        // what might be a perfectly valid repo whose `.git` we couldn't
        // read this moment — surface the error so the caller can retry.
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw err;
        }
      }
      if (alreadyCloned) {
        // We don't auto-pull because that could clobber another user's
        // in-progress lock-held edits. The tracking config IS re-stamped —
        // it never touches the working tree, and a drifted config is what
        // breaks the next pull.
        await this.normalizeCloneTracking(targetDir, branch);
        return;
      }
      // Half-built dir — wipe and re-clone.
      await fs.rm(targetDir, { recursive: true, force: true });
    }

    // Borrow an existing sibling clone's objects to skip the bulk download.
    // Resolved before the clone so a failure mid-clone still rolls back cleanly.
    const reference = await this.findSiblingRepo(branch);
    try {
      await this.runClone(targetDir, branch, reference);
      // Persist longpaths in the cloned repo's config so subsequent
      // checkouts also honor it.
      await execFileAsync('git', ['-C', targetDir, 'config', 'core.longpaths', 'true']);
      // Generic bot identity for the clone — every workflow commit
      // overrides via `--author=…` so the real human shows up in
      // `git log`. This is purely the fallback committer.
      await execFileAsync('git', ['-C', targetDir, 'config', 'user.name', BOT_NAME]);
      await execFileAsync('git', ['-C', targetDir, 'config', 'user.email', BOT_EMAIL]);
      // Pin the clone to exactly one fetch refspec and one upstream ref for
      // this branch. `git clone -b` already produces that shape; stamping it
      // explicitly means the shape is asserted rather than assumed, and the
      // same call is what repairs an existing clone that drifted.
      await this.normalizeCloneTracking(targetDir, branch);
      console.log(
        `[workspace] Cloned ${this.kbDirName} for branch "${branch}"` +
          (reference ? ' (referenced a sibling clone)' : ''),
      );
      // A fresh clone has already downloaded every ref — tell the git layer
      // so the first `listBranches` skips the redundant implicit `git fetch`.
      // Isolated from the clone-rollback `catch` below: a misbehaving listener
      // must not cause a successful clone to be wiped.
      try {
        this.onWorkspaceCloned?.(workspaceIdForBranch(branch));
      } catch (listenerErr) {
        console.error(
          `[workspace] onWorkspaceCloned listener failed for branch "${branch}":`,
          redactError(listenerErr),
        );
      }
    } catch (err) {
      const redacted = redactError(err);
      console.error(`[workspace] Failed to clone for branch "${branch}":`, redacted);
      // Roll back partial state so the next bootstrap retries cleanly.
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
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
    await fs.rm(workspaceDir, { recursive: true, force: true });
    const branch = branchForWorkspaceId(workspaceId);
    this.branchDirs.delete(branch);
  }

  async listFiles(workspaceId: string, readFilter?: ReadTreeFilter): Promise<FileTreeEntry> {
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    return this.buildFileTree(workspaceDir, workspaceDir, BevelIgnoreStack.empty(), readFilter);
  }

  async readFile(workspaceId: string, relativePath: string): Promise<string> {
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const absolutePath = path.resolve(workspaceDir, relativePath);
    this.assertWithinWorkspace(absolutePath, workspaceDir);
    return fs.readFile(absolutePath, 'utf-8');
  }

  async readFileBinary(workspaceId: string, relativePath: string): Promise<Buffer> {
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const absolutePath = path.resolve(workspaceDir, relativePath);
    this.assertWithinWorkspace(absolutePath, workspaceDir);
    return fs.readFile(absolutePath);
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
    const walk = async (dir: string, ignoreStack: BevelIgnoreStack): Promise<void> => {
      const nextStack = await ignoreStack.extendedWith(dir);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git' && entry.isDirectory()) continue;
        const childAbs = path.join(dir, entry.name);
        if (nextStack.isIgnored(childAbs, entry.isDirectory())) continue;
        if (entry.isDirectory()) {
          await walk(childAbs, nextStack);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const repoPath = path.relative(repoRoot, childAbs).replace(/\\/g, '/');
        files[repoPath] = await fs.readFile(childAbs, 'utf-8');
      }
    };
    await walk(repoRoot, BevelIgnoreStack.empty());
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
  async createFolderZip(workspaceId: string, relativePath: string): Promise<Buffer> {
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const absoluteRoot = path.resolve(workspaceDir, relativePath);
    this.assertWithinWorkspace(absoluteRoot, workspaceDir);
    const stat = await fs.stat(absoluteRoot);
    if (!stat.isDirectory()) {
      throw new Error('Not a directory');
    }

    const zipRoot = path.basename(absoluteRoot) || 'folder';
    const zip = new AdmZip();
    let totalBytes = 0;

    const walk = async (dir: string, ignoreStack: BevelIgnoreStack): Promise<void> => {
      const nextStack = await ignoreStack.extendedWith(dir);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name === '.git' && entry.isDirectory()) continue;
        if (entry.name === '.gitkeep' && entry.isFile()) continue;
        const childAbs = path.join(dir, entry.name);
        if (nextStack.isIgnored(childAbs, entry.isDirectory())) continue;
        if (entry.isDirectory()) {
          await walk(childAbs, nextStack);
          continue;
        }
        if (!entry.isFile()) continue; // skip sockets, symlinks, etc.
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
        const relInside = path
          .relative(absoluteRoot, childAbs)
          .replace(/\\/g, '/');
        zip.addFile(`${zipRoot}/${relInside}`, data);
      }
    };

    await walk(absoluteRoot, BevelIgnoreStack.empty());
    return zip.toBuffer();
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
    this.assertValidRepoRelativePath(relativePath);
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const repoDir = path.join(workspaceDir, this.kbDirName);

    const candidates = [ref];
    if (!ref.startsWith('origin/') && !ref.startsWith('refs/')) {
      candidates.push(`origin/${ref}`);
    }

    for (const candidate of candidates) {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['-C', repoDir, 'show', `${candidate}:${relativePath}`],
          { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
        );
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
   */
  async ensureRemotesFetched(workspaceId: string): Promise<void> {
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const repoDir = path.join(workspaceDir, this.kbDirName);
    const now = Date.now();
    const last = this.lastFetchAt.get(repoDir) ?? 0;
    if (now - last < FETCH_CACHE_TTL_MS) return;

    const inFlight = this.inFlightFetches.get(repoDir);
    if (inFlight) return inFlight;

    // This driver runs outside the git layer's per-workspace mutex, so it may
    // only run the safe implicit-fetch shape — see `SAFE_IMPLICIT_FETCH_ARGS`
    // in `kb-fs/clone-config.ts` for the full rationale.
    const promise = execFileAsync(
      'git',
      ['-C', repoDir, ...SAFE_IMPLICIT_FETCH_ARGS],
      { env: { ...process.env } },
    )
      .then(() => {
        this.lastFetchAt.set(repoDir, Date.now());
      })
      .catch((err) => {
        console.warn('[workspace] git fetch origin failed:', redactError(err));
      })
      .finally(() => {
        if (this.inFlightFetches.get(repoDir) === promise) {
          this.inFlightFetches.delete(repoDir);
        }
      });
    this.inFlightFetches.set(repoDir, promise);
    return promise;
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

  async deleteFile(workspaceId: string, relativePath: string): Promise<void> {
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const absolutePath = path.resolve(workspaceDir, relativePath);
    this.assertWithinWorkspace(absolutePath, workspaceDir);
    await fs.rm(absolutePath, { recursive: true, force: true });
    await this.diffService?.markUserDeleted(workspaceId, relativePath);
  }

  /**
   * Remove the workspace's `tmp/` directory — transient run artifacts (code-mode
   * tool-chain spills, staged SharePoint docs) that live at the workspace root,
   * outside the KB git repo, and are never committed. Computes the path directly
   * from `workspacesRoot` (no bootstrapping) and force-removes, so it's safe to
   * call after a run even if the workspace was already torn down — a missing
   * directory is ignored.
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

  async moveEntry(workspaceId: string, oldRelativePath: string, newRelativePath: string): Promise<void> {
    assertValidRelativePath(newRelativePath);
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const oldAbsolute = path.resolve(workspaceDir, oldRelativePath);
    const newAbsolute = path.resolve(workspaceDir, newRelativePath);
    this.assertWithinWorkspace(oldAbsolute, workspaceDir);
    this.assertWithinWorkspace(newAbsolute, workspaceDir);
    await fs.mkdir(path.dirname(newAbsolute), { recursive: true });
    await fs.rename(oldAbsolute, newAbsolute);
    if (this.diffService) {
      await this.diffService.markUserDeleted(workspaceId, oldRelativePath);
      await this.diffService.syncFromDisk(workspaceId, newRelativePath);
    }
  }

  async writeFile(
    workspaceId: string,
    relativePath: string,
    content: string,
    options?: { failIfExists?: boolean },
  ): Promise<void> {
    assertValidRelativePath(relativePath);
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const absolutePath = path.resolve(workspaceDir, relativePath);
    this.assertWithinWorkspace(absolutePath, workspaceDir);
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
    await this.diffService?.syncFromDisk(workspaceId, relativePath);
  }

  async createDirectory(workspaceId: string, relativePath: string): Promise<void> {
    assertValidRelativePath(relativePath);
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const absolutePath = path.resolve(workspaceDir, relativePath);
    this.assertWithinWorkspace(absolutePath, workspaceDir);
    await fs.mkdir(absolutePath, { recursive: true });
    const entries = await fs.readdir(absolutePath);
    if (entries.length === 0) {
      await fs.writeFile(path.join(absolutePath, '.gitkeep'), '', 'utf-8');
    }
  }

  async writeFileBinary(workspaceId: string, relativePath: string, data: Uint8Array): Promise<void> {
    assertValidRelativePath(relativePath);
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const absolutePath = path.resolve(workspaceDir, relativePath);
    this.assertWithinWorkspace(absolutePath, workspaceDir);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, data);
    await this.diffService?.syncFromDisk(workspaceId, relativePath);
  }

  /**
   * Extract a `.zip` file already present in the workspace into a destination
   * directory (defaults to the archive's parent directory — "unzip here").
   * Validation + zip-bomb guards are identical to the per-user version that
   * preceded the workspace-per-branch migration.
   */
  async unzipFile(
    workspaceId: string,
    zipRelativePath: string,
    destDirRelativePath?: string,
    /**
     * Per-extracted-path write guard (ontology-session boundary). Called with
     * each entry's workspace-relative target before it is written; if it throws,
     * the entry is skipped (with the thrown message as the reason) rather than
     * aborting the whole extraction. Omitted by non-agent / human callers.
     */
    guardWrite?: (wsRelativePath: string) => Promise<void>,
  ): Promise<UnzipResult> {
    const workspaceDir = await this.resolveWorkspaceDir(workspaceId);
    const zipAbsolute = path.resolve(workspaceDir, zipRelativePath);
    this.assertWithinWorkspace(zipAbsolute, workspaceDir);
    if (!zipRelativePath.toLowerCase().endsWith('.zip')) {
      throw new Error('Only .zip files can be extracted');
    }

    const inferredDest = (() => {
      const d = path.posix.dirname(zipRelativePath.replace(/\\/g, '/'));
      return d === '.' ? '' : d;
    })();
    const destRel = destDirRelativePath ?? inferredDest;
    if (destRel) assertValidRelativePath(destRel);
    const destAbsolute = destRel ? path.resolve(workspaceDir, destRel) : workspaceDir;
    this.assertWithinWorkspace(destAbsolute, workspaceDir);

    let zip: AdmZip;
    try {
      zip = new AdmZip(zipAbsolute);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read zip file: ${msg}`);
    }

    // The destination directory is created on demand by the first allowed entry
    // (each guarded path mkdirs its parents with `recursive: true`). Creating it
    // up front would leave it behind even when every entry is write-blocked.
    const extracted: string[] = [];
    const skipped: UnzipResult['skipped'] = [];
    let processedCount = 0;
    let totalUncompressed = 0;

    for (const entry of zip.getEntries()) {
      if (processedCount >= UNZIP_MAX_ENTRIES) {
        skipped.push({
          path: entry.entryName,
          reason: `Archive exceeds ${UNZIP_MAX_ENTRIES} entries`,
        });
        continue;
      }
      processedCount++;
      const rawName = entry.entryName.replace(/\\/g, '/');

      if (
        rawName.startsWith('__MACOSX/') ||
        rawName === '__MACOSX' ||
        rawName.endsWith('/.DS_Store') ||
        rawName === '.DS_Store' ||
        /(^|\/)\._/.test(rawName)
      ) {
        continue;
      }

      if (!rawName || rawName.startsWith('/') || /(^|\/)\.\.($|\/)/.test(rawName)) {
        skipped.push({ path: rawName || '(empty)', reason: 'Invalid path' });
        continue;
      }

      const trimmed = rawName.replace(/\/+$/, '');
      const segments = trimmed.split('/').filter((s) => s.length > 0);
      let invalidReason: string | null = null;
      for (const segment of segments) {
        const reason = validateFilename(segment);
        if (reason) {
          invalidReason = reason;
          break;
        }
      }
      if (invalidReason) {
        skipped.push({ path: rawName, reason: invalidReason });
        continue;
      }

      const targetAbsolute = path.resolve(destAbsolute, ...segments);
      const destRoot = path.resolve(destAbsolute);
      if (targetAbsolute !== destRoot && !targetAbsolute.startsWith(destRoot + path.sep)) {
        skipped.push({ path: rawName, reason: 'Path escapes destination' });
        continue;
      }

      const relForReport = path
        .relative(workspaceDir, targetAbsolute)
        .replace(/\\/g, '/');
      // Ontology-session boundary: a write-blocked (or cross-ontology) entry is
      // skipped, not extracted, so an archive can't be a write path around it.
      // Runs before any filesystem side effect — including directory creation —
      // so a blocked entry leaves nothing behind on disk.
      const allowEntry = async (): Promise<boolean> => {
        if (!guardWrite) return true;
        try {
          await guardWrite(relForReport);
          return true;
        } catch (err) {
          skipped.push({ path: rawName, reason: err instanceof Error ? err.message : 'Blocked by the ontology-session boundary' });
          return false;
        }
      };

      if (entry.isDirectory) {
        if (!(await allowEntry())) continue;
        await fs.mkdir(targetAbsolute, { recursive: true });
        continue;
      }

      const declaredSize = entry.header?.size ?? 0;
      if (declaredSize > UNZIP_MAX_ENTRY_BYTES) {
        skipped.push({
          path: rawName,
          reason: `Entry exceeds ${UNZIP_MAX_ENTRY_BYTES} byte per-file limit`,
        });
        continue;
      }
      if (totalUncompressed + declaredSize > UNZIP_MAX_TOTAL_BYTES) {
        skipped.push({
          path: rawName,
          reason: `Archive exceeds ${UNZIP_MAX_TOTAL_BYTES} byte total uncompressed limit`,
        });
        continue;
      }

      const data = entry.getData();
      if (data.byteLength > UNZIP_MAX_ENTRY_BYTES) {
        skipped.push({
          path: rawName,
          reason: `Entry exceeds ${UNZIP_MAX_ENTRY_BYTES} byte per-file limit`,
        });
        continue;
      }
      if (totalUncompressed + data.byteLength > UNZIP_MAX_TOTAL_BYTES) {
        skipped.push({
          path: rawName,
          reason: `Archive exceeds ${UNZIP_MAX_TOTAL_BYTES} byte total uncompressed limit`,
        });
        continue;
      }
      if (!(await allowEntry())) continue;
      await fs.mkdir(path.dirname(targetAbsolute), { recursive: true });
      await fs.writeFile(targetAbsolute, data);
      totalUncompressed += data.byteLength;
      extracted.push(relForReport);
      await this.diffService?.syncFromDisk(workspaceId, relForReport);
    }

    return {
      destination: path.relative(workspaceDir, destAbsolute).replace(/\\/g, '/') || '.',
      extracted,
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
    try {
      await fs.access(path.join(workspaceDir, this.kbDirName, '.git'));
      return true;
    } catch {
      return false;
    }
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
      ({ stdout } = await execFileAsync('git', ['-C', repoDir, 'status', '--porcelain=v1', '-z'], {
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (err) {
      console.warn(
        `[workspace] orphan scan via git status failed for ${workspaceId}:`,
        err instanceof Error ? err.message : err,
      );
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
        console.warn(
          `[workspace] sweep failed for ${entry.name}:`,
          err instanceof Error ? err.message : err,
        );
      }
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
    try {
      await fs.access(path.join(workspaceDir, this.kbDirName, '.git'));
      this.branchDirs.set(branch, workspaceDir);
      return workspaceDir;
    } catch {
      // Fall through to lazy bootstrap.
    }
    try {
      await this.getOrCreateForBranch(branch);
      const dir = this.branchDirs.get(branch);
      if (dir) return dir;
      // Bootstrap reported success but didn't register — defensive fallback.
      return workspaceDir;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid workspace ID "${workspaceId}": ${reason}`);
    }
  }

  private assertWithinWorkspace(absolutePath: string, workspaceDir: string): void {
    const resolved = path.resolve(absolutePath);
    const root = path.resolve(workspaceDir);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error('Path traversal detected');
    }
  }

  private async buildFileTree(
    dir: string,
    workspaceRoot: string,
    parentIgnore: BevelIgnoreStack,
    readFilter?: ReadTreeFilter,
  ): Promise<FileTreeEntry> {
    const name = path.basename(dir);
    const relativePath = path.relative(workspaceRoot, dir).replace(/\\/g, '/');
    const entries = await fs.readdir(dir, { withFileTypes: true });

    const ignoreStack = await parentIgnore.extendedWith(dir);

    // First pass: the entries surviving `.git`/`.gitkeep` + `.bevelignore`.
    const candidates: { entry: (typeof entries)[number]; entryPath: string; rel: string }[] = [];
    for (const entry of entries) {
      // `.git/` is never user content and listing it would blow up the
      // tree response. `.gitkeep` is the empty-folder placeholder — not
      // worth surfacing in the file list.
      if (entry.name === '.git' && entry.isDirectory()) continue;
      if (entry.name === '.gitkeep' && entry.isFile()) continue;

      const entryPath = path.join(dir, entry.name);
      if (ignoreStack.isIgnored(entryPath, entry.isDirectory())) continue;

      candidates.push({
        entry,
        entryPath,
        rel: path.relative(workspaceRoot, entryPath).replace(/\\/g, '/'),
      });
    }

    // Read-permission filter: ONE batched check per directory. Drops files AND
    // directories the caller can't read; a hidden directory's subtree is never
    // walked (skip-and-don't-recurse). A readable directory left empty after
    // filtering stays visible (the folder itself is readable). Fail-closed:
    // anything not explicitly readable is dropped. No filter → identical to the
    // pre-feature tree (regression-safe).
    let visible = candidates;
    if (readFilter && candidates.length > 0) {
      const verdict = await readFilter(candidates.map((c) => c.rel));
      visible = candidates.filter((c) => verdict.get(c.rel) === true);
    }

    const children: FileTreeEntry[] = [];
    for (const { entry, entryPath, rel } of visible) {
      if (entry.isDirectory()) {
        children.push(await this.buildFileTree(entryPath, workspaceRoot, ignoreStack, readFilter));
      } else {
        children.push({ name: entry.name, relativePath: rel, type: 'file' });
      }
    }

    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      name,
      relativePath: relativePath || '.',
      type: 'directory',
      children,
    };
  }
}
