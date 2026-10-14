import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../shared/logging.js';
import { GitRunError, type IGitRunner } from '../../shared/git.contract.js';
import { isAbsence } from '../../shared/fs.contract.js';
import { redactSecret, urlQuerySecrets } from '../../shared/redact-secret.js';
import { WorkspaceMutex } from '../kb-fs/mutex.js';
import { NodeGitRunner } from '../workflow/git/node-git-runner.js';
import {
  cloneCredentialConfigArgs,
  cloneTrackingConfigArgs,
  ORIGIN_FETCH_REFSPEC,
  SAFE_IMPLICIT_FETCH_ARGS,
} from '../kb-fs/clone-config.js';

const log = logger('kb-repository');

/**
 * ONE repository per knowledge base, and every branch workspace a worktree of
 * it.
 *
 * A branch workspace used to be a full clone: every object of the history
 * once per branch, and a fetch per branch. A workspace is only ever checked
 * out on its own branch and never switches, so almost all of that was the
 * same history copied over and over (142 branches, 60 GB, on 2026-10-14).
 * Git's own answer to "many checkouts, one history" is a worktree: this
 * repository holds the objects, the remote-tracking refs and each branch's
 * local ref, and `<workspacesRoot>/<branch id>/<kb folder>` — the path a
 * clone had — is a worktree of it. Its `.git` is a FILE pointing here.
 *
 * Bare, so no branch is checked out in the repository itself (a non-bare
 * clone would hold the default branch, which is one of the workspaces), and
 * with no local branches at all until a worktree adds one: the remote's
 * branches arrive under `refs/remotes/origin/*`, exactly where a clone keeps
 * them, so `origin/<branch>` reads the same from a worktree as from a clone.
 *
 * It lives OUTSIDE the workspaces root, so the orphan sweep (which removes
 * every folder there that is not a known branch's) never sees it.
 *
 * What changes what every worktree shares — a fetch, a worktree add, remove
 * or prune, the repository's configuration — runs under the repository-level
 * reservation of the {@link WorkspaceMutex} (`runRepository`). Git operations
 * inside one worktree keep their canonical workspace key, and two worktrees
 * run side by side.
 */

/** A first fetch of a large knowledge base takes minutes; the floor under its deadline. */
const FIRST_FETCH_TIMEOUT_MS = 600_000;

/**
 * Git waits this long for another process's `packed-refs.lock` before failing
 * (the default is one second). A fetch that prunes and a branch delete in
 * another worktree both rewrite `packed-refs`, which is now one file for every
 * workspace.
 */
const PACKED_REFS_TIMEOUT_MS = '10000';

/** Written into the repository last, once its first fetch has landed — see `exists`. */
const READY_MARKER = 'hexis-repository-ready';

/** Fallback committer identity; every workflow commit overrides it with `--author`. */
const BOT_NAME = 'Bevel Workflow';
const BOT_EMAIL = 'bevel-workflow@bevel.software';

/**
 * Where the repository is: `<root>/<kb folder>.git`, under `override` when the
 * composition root names one (a folder on a persistent volume beside the
 * workspaces root), else a folder next to the workspaces root named after it.
 *
 * The fallback is derived from the root's own name, so two workspaces roots
 * that share a parent (every suite's temporary roots) never share a repository.
 */
export function repositoryDirFor(workspacesRoot: string, kbDirName: string, override?: string): string {
  const root = override ?? `${path.resolve(workspacesRoot)}.repository`;
  return path.join(root, `${kbDirName}.git`);
}

/**
 * What a branch workspace's checkout folder is:
 *  - `worktree` — its `.git` is a file naming a folder that exists;
 *  - `clone` — its `.git` is a folder: a full clone, from a release before
 *    worktrees (converted at boot, and served as it is until it is);
 *  - `broken` — its `.git` is a file naming a folder that does not exist (the
 *    repository was lost, or the worktree was pruned from under it): an
 *    unfinished checkout, recreated as an unfinished clone is;
 *  - `none` — no `.git` at all.
 *
 * Errors other than absence propagate: a `.git` that could not be read has
 * not been shown to be anything.
 */
export type WorkingCopyShape = 'worktree' | 'clone' | 'broken' | 'none';

export async function workingCopyShape(checkoutDir: string): Promise<WorkingCopyShape> {
  const dotGit = path.join(checkoutDir, '.git');
  let stat;
  try {
    stat = await fs.stat(dotGit);
  } catch (err) {
    if (isAbsence(err)) return 'none';
    throw err;
  }
  if (stat.isDirectory()) return 'clone';
  const gitdir = await readGitfile(dotGit);
  if (gitdir === null) return 'broken';
  return (await fs.stat(gitdir).then((s) => s.isDirectory(), () => false)) ? 'worktree' : 'broken';
}

/**
 * The folder a gitfile (`gitdir: <path>`) names, resolved against the file's
 * own folder as git does; null when the file says nothing of the kind.
 */
export async function readGitfile(gitfile: string): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(gitfile, 'utf-8');
  } catch (err) {
    if (isAbsence(err) || (err as NodeJS.ErrnoException).code === 'EISDIR') return null;
    throw err;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  return path.resolve(path.dirname(gitfile), m[1]!);
}

export interface KbRepositoryOptions {
  /** The bare repository's folder — see {@link repositoryDirFor}. */
  dir: string;
  /** The configured remote, read at every use (the setup screen can change it). */
  kbRepoUrl: () => string;
  gitRunner?: IGitRunner;
  /**
   * The mutex the git layer serializes worktree operations under. The same
   * instance, so that the repository-level reservation here waits for them.
   */
  mutex?: WorkspaceMutex;
}

export interface FetchOptions {
  /** A fetch that SUCCEEDED this recently is fresh enough; nothing runs. */
  maxAgeMs: number;
  /** Skip the freshness window (the in-flight join still applies). */
  force?: boolean;
  /**
   * A fetch that FAILED this recently is not retried: the answer is the
   * failure. For pollers, so a host that is down is not asked again on every
   * request. Absent, a failure is retried on the next call.
   */
  failureBackoffMs?: number;
}

export class KbRepository {
  readonly dir: string;
  private readonly kbRepoUrl: () => string;
  private readonly gitRunner: IGitRunner;
  readonly mutex: WorkspaceMutex;

  /** When the last fetch succeeded, and when the last attempt failed. */
  private lastSuccessAt = 0;
  private lastFailureAt = 0;
  private lastOk: boolean | null = null;
  private inFlightFetch: Promise<boolean> | null = null;
  /**
   * Bumped whenever the repository is taken away (set aside): a fetch that was
   * in flight for the one that went must not stamp its result on the new one.
   */
  private generation = 0;

  /** The credential fingerprint last stamped into the repository's config, this process. */
  private stampedCredentials: string | null = null;
  /** Whether this process has stamped the repository's own configuration yet. */
  private configStamped = false;

  constructor(opts: KbRepositoryOptions) {
    this.dir = path.resolve(opts.dir);
    this.kbRepoUrl = opts.kbRepoUrl;
    this.gitRunner = opts.gitRunner ?? new NodeGitRunner();
    this.mutex = opts.mutex ?? new WorkspaceMutex();
  }

  private redact(text: string): string {
    return redactSecret(text, [this.gitRunner.credentials.token(), ...urlQuerySecrets(this.kbRepoUrl())]);
  }

  private async git(args: string[], timeoutMs?: number): Promise<string> {
    const { stdout } = await this.gitRunner.run(this.dir, args, timeoutMs ? { timeoutMs } : undefined);
    return stdout;
  }

  /**
   * Whether the repository is on disk and FINISHED: a bare repository whose
   * first fetch landed. The marker is written last, so a repository whose
   * making was cut short (a crash, a full disk) is not taken for one.
   */
  async exists(): Promise<boolean> {
    return fs.access(path.join(this.dir, READY_MARKER)).then(() => true, () => false);
  }

  /**
   * Make sure the repository exists and has been fetched at least once; create
   * it when it does not. Under the repository reservation. Throws when it
   * cannot be created or its first fetch fails — with git's words, redacted.
   */
  async ensure(): Promise<void> {
    await this.mutex.runRepository(() => this.ensureHeld());
  }

  private async ensureHeld(): Promise<void> {
    if (await this.exists()) {
      await this.stampConfigIfNeeded();
      return;
    }
    const url = this.kbRepoUrl().trim();
    if (url === '') throw new Error('The knowledge-base repository address is not configured.');
    // Made in place, and marked finished only once it has the remote's refs.
    // What a making cut short left here holds no worktree (none is added
    // before the marker) and nothing that is not on the remote: it is
    // cleared and made again.
    await fs.rm(this.dir, { recursive: true, force: true });
    await fs.mkdir(this.dir, { recursive: true });
    try {
      await this.gitRunner.run(this.dir, ['init', '--bare', '--quiet', this.dir]);
      for (const args of this.configArgs(url)) await this.gitRunner.run(this.dir, args);
      for (const args of cloneCredentialConfigArgs(this.gitRunner.credentials)) {
        await this.gitRunner.run(this.dir, args).catch(() => undefined);
      }
      await this.gitRunner.run(this.dir, ['fetch', '--prune', '--no-write-fetch-head', '--quiet', 'origin'], {
        timeoutMs: Math.max(this.gitRunner.defaultTimeoutMs, FIRST_FETCH_TIMEOUT_MS),
      });
      await fs.writeFile(
        path.join(this.dir, READY_MARKER),
        'The knowledge base repository every branch workspace is a worktree of. Made by Hexis.\n',
      );
    } catch (err) {
      await fs.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    this.configStamped = true;
    this.stampedCredentials = this.credentialFingerprint();
    this.noteFetched(true);
    log.info(`created the knowledge-base repository at ${this.dir}`);
  }

  /** The repository's own configuration — what every worktree of it reads. */
  private configArgs(url: string): string[][] {
    return [
      ['config', 'remote.origin.url', url],
      ['config', '--replace-all', 'remote.origin.fetch', ORIGIN_FETCH_REFSPEC],
      // A KB has paths over 260 characters; without this a Windows checkout drops them.
      ['config', 'core.longpaths', 'true'],
      ['config', 'core.packedRefsTimeout', PACKED_REFS_TIMEOUT_MS],
      // See `cloneTrackingConfigArgs`: an automatic gc forked into the
      // background becomes a zombie under a node server.
      ['config', 'gc.autoDetach', 'false'],
      ['config', 'user.name', BOT_NAME],
      ['config', 'user.email', BOT_EMAIL],
    ];
  }

  private credentialFingerprint(): string {
    const { credentials } = this.gitRunner;
    return `${credentials.username()}::${credentials.token() ? '1' : '0'}`;
  }

  /**
   * Stamp the repository's configuration once per process, and its credential
   * helper again whenever the deployment's credential changed — once for every
   * worktree, since they all read this one config. Never throws: a stamp that
   * failed leaves the repository as usable as it was, and is tried again next
   * time.
   */
  private async stampConfigIfNeeded(): Promise<void> {
    if (!this.configStamped) {
      try {
        // The address is NOT rewritten here: a repository of another address
        // is set aside, never re-pointed (see `isOfAnotherRepository`).
        for (const args of this.configArgs('').slice(1)) await this.git(args);
        this.configStamped = true;
      } catch (err) {
        log.warn('could not stamp the knowledge-base repository configuration:', {
          detail: this.redact(err instanceof Error ? err.message : String(err)),
        });
      }
    }
    if (this.stampedCredentials === this.credentialFingerprint()) return;
    let argLists: string[][];
    try {
      argLists = cloneCredentialConfigArgs(this.gitRunner.credentials);
    } catch (err) {
      log.warn('refusing to stamp the credential helper of the knowledge-base repository:', {
        detail: this.redact(err instanceof Error ? err.message : String(err)),
      });
      return;
    }
    let stamped = true;
    for (const args of argLists) {
      try {
        await this.git(args);
      } catch (err) {
        // `--unset-all` of a helper that is not there exits 5: nothing to do.
        if (!(args.includes('--unset-all') && (err as GitRunError).exitCode === 5)) stamped = false;
      }
    }
    this.stampedCredentials = stamped ? this.credentialFingerprint() : null;
  }

  /**
   * Bring the credential helper into line with the deployment's credential when
   * it changed since it was last stamped. Under the repository reservation, as
   * every write to the shared config is. A no-op for a repository not yet made.
   */
  async refreshCredentials(): Promise<void> {
    if (this.stampedCredentials === this.credentialFingerprint() && this.configStamped) return;
    await this.mutex.runRepository(async () => {
      if (await this.exists()) await this.stampConfigIfNeeded();
    });
  }

  /**
   * Run `git config` arguments against the repository's shared configuration
   * (from a worktree or the repository, it is one file), one writer at a time:
   * git refuses a second writer while `config.lock` is held rather than
   * waiting for it.
   */
  async writeConfig(cwd: string, argLists: readonly string[][]): Promise<void> {
    await this.mutex.runRepository(async () => {
      for (const args of argLists) await this.gitRunner.run(cwd, args);
    });
  }

  private noteFetched(ok: boolean): void {
    const now = Date.now();
    this.lastOk = ok;
    if (ok) this.lastSuccessAt = now;
    else this.lastFailureAt = now;
  }

  /** The last time the repository reached the remote and whether it worked; null before any attempt. */
  lastContact(): { at: number; ok: boolean } | null {
    if (this.lastOk === null) return null;
    return { at: Math.max(this.lastSuccessAt, this.lastFailureAt), ok: this.lastOk };
  }

  /** Why the last fetch failed, redacted; null when it did not. For a fail-closed caller's message. */
  lastFetchFailure(): string | null {
    return this.lastOk === false ? this.lastFailure : null;
  }

  private lastFailure: string | null = null;

  /**
   * `git fetch --prune origin` in the repository — ONCE for every workspace.
   * Throttled by `maxAgeMs`, joined while in flight (ten callers in one tick
   * share one fetch), and run under the repository reservation, so it waits
   * for the worktree operations in flight and holds back the ones that are
   * not. Answers whether the remote-tracking refs are provably fresh: this
   * call's fetch (or the one it joined) succeeded, or one succeeded within
   * the window. Never throws; a caller that must not act on stale refs reads
   * the answer.
   */
  async fetch(opts: FetchOptions): Promise<boolean> {
    const now = Date.now();
    if (!opts.force && now - this.lastSuccessAt < opts.maxAgeMs) return true;
    // Joined PARKED: the fetch in flight may be waiting for every running
    // worktree operation, and the caller may be one.
    if (this.inFlightFetch) return this.mutex.whileParked(this.inFlightFetch);
    if (!opts.force && opts.failureBackoffMs && now - this.lastFailureAt < opts.failureBackoffMs) {
      return false;
    }
    const generation = this.generation;
    const promise = this.mutex
      .runRepository(async () => {
        if (!(await this.exists())) {
          await this.ensureHeld();
          return;
        }
        await this.stampConfigIfNeeded();
        await this.git([
          // A transfer that stalls below 1 KB/s for ten seconds is abandoned,
          // so a hung host cannot park every workspace behind it.
          '-c', 'http.lowSpeedLimit=1000',
          '-c', 'http.lowSpeedTime=10',
          ...SAFE_IMPLICIT_FETCH_ARGS,
        ]);
      })
      .then(
        () => {
          if (generation === this.generation) this.noteFetched(true);
          return true;
        },
        (err: unknown) => {
          if (generation === this.generation) {
            this.noteFetched(false);
            this.lastFailure = this.redact(err instanceof Error ? err.message : String(err));
          }
          log.warn('git fetch origin failed:', {
            detail: this.redact(err instanceof Error ? err.message : String(err)),
          });
          return false;
        },
      )
      .finally(() => {
        if (this.inFlightFetch === promise) this.inFlightFetch = null;
      });
    this.inFlightFetch = promise;
    return promise;
  }

  /**
   * Forget what this process knows about the repository — it was set aside,
   * and the next use makes a fresh one.
   */
  forget(): void {
    this.generation++;
    this.lastSuccessAt = 0;
    this.lastFailureAt = 0;
    this.lastOk = null;
    this.inFlightFetch = null;
    this.configStamped = false;
    this.stampedCredentials = null;
  }

  private async revParse(ref: string): Promise<string | null> {
    try {
      return (await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null;
    } catch {
      return null;
    }
  }

  private async isAncestor(ancestor: string, of: string): Promise<boolean> {
    try {
      await this.git(['merge-base', '--is-ancestor', ancestor, of]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Add the worktree of `branch` at `checkoutDir`. Copies no history: the
   * repository already has it, and is fetched first when the remote's branch
   * is not known to it yet.
   *
   * The branch's local ref is created from `origin/<branch>`, tracking it. A
   * local ref already there (a converted clone's tip, a worktree that was lost
   * with commits the remote lacks) is KEPT when it holds commits the remote
   * does not have, and fast-forwarded to the remote when it is behind.
   *
   * A branch the remote does not have fails with git's own words for a clone
   * of it ("Remote branch … not found in upstream origin"), so the callers
   * that tell a deleted branch from one that never existed read it as they
   * read a clone's failure — unless `allowLocalOnly` (a converted clone whose
   * branch was never pushed) and the local ref exists.
   *
   * `keepLocalTip` (a conversion) leaves a local ref that is behind the
   * remote where it is: the worktree comes up at the clone's own tip, and the
   * phase's own update moves it on, as it moved the clone.
   *
   * `withinFetchWindowMs` (the startup phase, opening every branch) skips
   * asking the remote when the repository's own fetch succeeded that recently
   * and already has `origin/<branch>`: that fetch brought every branch, so
   * opening a hundred branches costs one fetch, not a hundred. A branch it
   * does not know yet is asked for as usual.
   */
  async addWorktree(
    branch: string,
    checkoutDir: string,
    opts: { allowLocalOnly?: boolean; keepLocalTip?: boolean; withinFetchWindowMs?: number } = {},
  ): Promise<void> {
    await this.mutex.runRepository(async () => {
      await this.ensureHeld();
      // A registration left behind by a folder deleted without git (a crash,
      // an operator) would make git refuse the path, or the branch, as taken.
      await this.git(['worktree', 'prune']);
      // The remote is ASKED for the branch, as a clone of it asked: the
      // repository's tracking ref may be from before the branch moved, or was
      // deleted, on the host. One branch, not the whole remote.
      let missing = false;
      const fresh =
        opts.withinFetchWindowMs !== undefined &&
        Date.now() - this.lastSuccessAt < opts.withinFetchWindowMs &&
        (await this.revParse(`refs/remotes/origin/${branch}`)) !== null;
      if (!fresh) {
        try {
          await this.git(['fetch', '--no-write-fetch-head', '--quiet', 'origin',
            `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!/couldn't find remote ref/i.test(message)) throw err;
          missing = true;
          // What the repository still says about it is stale.
          await this.git(['update-ref', '-d', `refs/remotes/origin/${branch}`]).catch(() => undefined);
        }
      }
      const local = await this.revParse(`refs/heads/${branch}`);
      if (missing && !(opts.allowLocalOnly && local !== null)) {
        throw new Error(`Remote branch ${branch} not found in upstream origin`);
      }
      await fs.mkdir(path.dirname(checkoutDir), { recursive: true });
      if (local === null) {
        await this.git(['worktree', 'add', '--quiet', '--track', '-b', branch, checkoutDir, `refs/remotes/origin/${branch}`]);
      } else {
        const remote = missing ? null : await this.revParse(`refs/remotes/origin/${branch}`);
        if (!opts.keepLocalTip && remote !== null && local !== remote && (await this.isAncestor(local, remote))) {
          await this.git(['update-ref', `refs/heads/${branch}`, remote, local]);
        }
        await this.git(['worktree', 'add', '--quiet', checkoutDir, branch]);
      }
      // The branch tracks `origin/<branch>`, exactly one fetch refspec and
      // one upstream ref, as a fresh clone of it would.
      for (const args of cloneTrackingConfigArgs(branch)) await this.git(args);
    });
  }

  /**
   * Remove the worktree at `checkoutDir` and prune it from the repository,
   * with its branch's local ref: deleting a workspace takes what a deleted
   * clone took. The repository's objects and every other worktree are left
   * exactly as they were. A folder git will not remove (it is not a worktree
   * any more, or is locked) is deleted by hand, then pruned.
   */
  async removeWorktree(checkoutDir: string, branch: string): Promise<void> {
    await this.mutex.runRepository(async () => {
      if (!(await this.exists())) {
        await fs.rm(checkoutDir, { recursive: true, force: true });
        return;
      }
      await this.git(['worktree', 'remove', '--force', '--force', checkoutDir]).catch(async () => {
        await fs.rm(checkoutDir, { recursive: true, force: true });
      });
      await this.git(['worktree', 'prune']);
      await this.git(['branch', '-D', '--', branch]).catch(() => undefined);
    });
  }

  /**
   * After worktree folders were deleted by hand (the orphan sweep): prune them
   * from the repository and drop their branches' local refs. A branch still
   * checked out in a worktree that exists is refused by git and kept.
   */
  async forgetWorktrees(branches: readonly string[]): Promise<void> {
    await this.mutex.runRepository(async () => {
      if (!(await this.exists())) return;
      await this.git(['worktree', 'prune']);
      for (const branch of branches) {
        if ((await this.revParse(`refs/heads/${branch}`)) === null) continue;
        await this.git(['branch', '-D', '--', branch]).catch(() => undefined);
      }
    });
  }

  /** `git worktree prune`: forget worktrees whose folders are gone. */
  async prune(): Promise<void> {
    await this.mutex.runRepository(async () => {
      if (await this.exists()) await this.git(['worktree', 'prune']);
    });
  }

  /** The folders of the repository's worktrees, as git lists them. */
  async listWorktrees(): Promise<string[]> {
    if (!(await this.exists())) return [];
    const out = await this.git(['worktree', 'list', '--porcelain']);
    const dirs: string[] = [];
    for (const line of out.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const dir = path.resolve(line.slice('worktree '.length).trim());
      if (dir !== this.dir) dirs.push(dir);
    }
    return dirs;
  }

  /**
   * Bring the tip of `branch` from the full clone at `cloneDir` into the
   * repository as `refs/heads/<branch>` — its commits the remote lacks
   * included — without touching the remote. Answers the tip, after checking
   * the repository now has it.
   */
  async importBranch(cloneDir: string, branch: string): Promise<string> {
    return this.mutex.runRepository(async () => {
      await this.ensureHeld();
      const tip = (
        await this.gitRunner.run(cloneDir, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
      ).stdout.trim();
      await this.git(['fetch', '--no-tags', '--no-write-fetch-head', '--quiet', cloneDir,
        `+refs/heads/${branch}:refs/heads/${branch}`]);
      const imported = await this.revParse(`refs/heads/${branch}`);
      if (imported !== tip) {
        throw new Error(`the repository holds ${imported ?? 'nothing'} for "${branch}" after the import, not ${tip}`);
      }
      return tip;
    });
  }

  /**
   * The address the repository fetches from, or null when it cannot be read
   * (no repository, no `origin`).
   */
  async originUrl(): Promise<string | null> {
    if (!(await this.exists())) return null;
    try {
      return (await this.git(['config', '--get', 'remote.origin.url'])).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Re-link a repository and its worktrees that were moved together (set
   * aside), so `git log` in a moved worktree reads the moved repository.
   *
   * Both links are written here rather than left to `git worktree repair`,
   * which cannot follow a link whose two ends BOTH moved: the worktree's
   * `.git` file names `<repository>/worktrees/<name>`, and that folder's
   * `gitdir` names the worktree's `.git`. The name is the last part of the
   * path the worktree's `.git` file still holds. Answers the moved worktrees
   * that could not be re-linked (git had already lost track of them, or a
   * write failed) — their files are all there, only `git` in them is not.
   */
  async relinkMovedCopy(movedRepository: string, movedWorktrees: readonly string[]): Promise<string[]> {
    const gitPath = (p: string): string => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);
    const unlinked: string[] = [];
    for (const worktree of movedWorktrees) {
      try {
        const gitfile = path.join(worktree, '.git');
        const old = await readGitfile(gitfile);
        if (old === null) throw new Error('its .git file names no folder');
        const admin = path.join(movedRepository, 'worktrees', path.basename(old));
        if (!(await fs.stat(admin).then((st) => st.isDirectory(), () => false))) {
          throw new Error(`the repository has no ${admin}`);
        }
        await fs.writeFile(gitfile, `gitdir: ${gitPath(admin)}\n`);
        await fs.writeFile(path.join(admin, 'gitdir'), `${gitPath(gitfile)}\n`);
      } catch (err) {
        unlinked.push(worktree);
        log.warn(`the set-aside worktree ${worktree} could not be re-linked to the set-aside repository:`, {
          detail: this.redact(err instanceof Error ? err.message : String(err)),
        });
      }
    }
    return unlinked;
  }

  /**
   * Point the repository at `url` — the same repository at a new address.
   * What this process knew of the old address's fetches is forgotten with it,
   * so the next fetch reaches the new one rather than reading a success from
   * the old one as fresh.
   */
  async setOriginUrl(url: string): Promise<void> {
    await this.mutex.runRepository(async () => {
      await this.git(['remote', 'set-url', 'origin', url]);
      this.generation++;
      this.lastSuccessAt = 0;
      this.lastFailureAt = 0;
      this.lastOk = null;
      this.lastFailure = null;
    });
  }
}
