import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../shared/logging.js';
import type { GitRunError} from '../../shared/git.contract.js';
import { type IGitRunner } from '../../shared/git.contract.js';
import { isAbsence } from '../../shared/fs.contract.js';
import { redactSecret, urlQuerySecrets } from '../../shared/redact-secret.js';
import type { AddWorktreeOptions, FetchOptions, IKbRepository } from './kb-repository.contract.js';
import { fetchInstant } from './fetch-instant.js';
import { readGitfile } from '../kb-fs/index.js';
import {
  cloneCredentialConfigArgs,
  cloneTrackingConfigArgs,
  ORIGIN_FETCH_REFSPEC,
  SAFE_IMPLICIT_FETCH_ARGS,
} from '../kb-fs/index.js';

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
 * Git was built for many worktrees of one repository and protects what they
 * share with its own locks: one per ref while it is written, one for
 * `packed-refs` (which git waits for, `core.packedRefsTimeout`), one per
 * worktree's index, objects written to a temp file and renamed into place,
 * and a worktree being added marked locked until it is. So git operations
 * in two worktrees run side by side here, as two developers' worktrees do,
 * under nothing but the per-workspace mutex the git layer always held.
 *
 * What git does NOT wait for is its one config file — a second writer is
 * refused, not queued — and what nothing in git serializes is the making of
 * the repository and the moving of its folders. Those three run as the
 * repository's one administrator, {@link exclusive}: the only lock this
 * class adds.
 *
 * Automatic garbage collection is off (`gc.auto 0`): a commit in one
 * worktree would otherwise collect beside every other worktree's work. The
 * startup phase runs {@link maintain} once per boot instead, when nothing
 * is served.
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

/** Where a converted clone's stash and other local refs are kept, per workspace (see `importLocalRefs`). */
export const CONVERTED_REFS = 'refs/kb-converted';

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
  let held;
  try {
    held = await fs.stat(gitdir);
  } catch (err) {
    // Only absence shows the worktree gone; EACCES or EIO shows nothing, and a
    // `broken` answer would have the checkout recreated over it.
    if (isAbsence(err)) return 'broken';
    throw err;
  }
  return held.isDirectory() ? 'worktree' : 'broken';
}

/**
 * Replace the contents of a file that exists, keeping the file. Git for
 * Windows marks a worktree's `.git` file hidden, and Windows refuses to
 * re-create a hidden file (`fs.writeFile` opens with `w`: EPERM) — so the
 * file is opened as it is and truncated instead.
 */
async function rewriteFile(file: string, text: string): Promise<void> {
  const handle = await fs.open(file, 'r+');
  try {
    await handle.truncate(0);
    await handle.write(text, 0);
  } finally {
    await handle.close();
  }
}

export interface KbRepositoryOptions {
  /** The bare repository's folder — see {@link repositoryDirFor}. */
  dir: string;
  /** The configured remote, read at every use (the setup screen can change it). */
  kbRepoUrl: () => string;
  /** Injected by the composition root, as every other git caller's is. */
  gitRunner: IGitRunner;
}

export type { AddWorktreeOptions, FetchOptions, IKbRepository } from './kb-repository.contract.js';

export class KbRepository implements IKbRepository {
  readonly dir: string;
  private readonly kbRepoUrl: () => string;
  private readonly gitRunner: IGitRunner;

  /** The administrator's queue: `exclusive` sections run one after another, in call order. */
  private admin: Promise<unknown> = Promise.resolve();

  /** See the contract: the repository's one administrator for `fn`'s duration. Never nested. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.admin.catch(() => undefined).then(fn);
    this.admin = next;
    return next;
  }

  /** When the last fetch succeeded, and when the last attempt failed. */
  private lastSuccessAt = 0;
  private lastFailureAt = 0;
  private lastOk: boolean | null = null;
  private inFlightFetch: Promise<boolean> | null = null;
  /** When the fetch in flight started: a caller that needs one from `fetchedSince` on joins only a later one. */
  private inFlightStartedAt = 0;
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
    this.gitRunner = opts.gitRunner;
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
    try {
      await fs.access(path.join(this.dir, READY_MARKER));
      return true;
    } catch (err) {
      // Only absence is "not there". A marker that could not be read (EACCES,
      // EIO, a process out of file descriptors) has shown nothing, and a false
      // answer would have `ensureHeld` clear a repository that is whole, with
      // every worktree's unpushed commits in it.
      if (isAbsence(err)) return false;
      throw err;
    }
  }

  /**
   * Make sure the repository exists and has been fetched at least once; create
   * it when it does not. As the administrator. Throws when it cannot be
   * created or its first fetch fails — with git's words, redacted.
   */
  async ensure(): Promise<void> {
    await this.exclusive(() => this.ensureHeld());
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
    let fetchedAt = fetchInstant();
    let credentialsStamped = true;
    try {
      await this.gitRunner.run(this.dir, ['init', '--bare', '--quiet', this.dir]);
      for (const args of this.configArgs(url)) await this.gitRunner.run(this.dir, args);
      // The helper's write is not what makes the repository: one that failed
      // is tried again by `refreshCredentials`, which is why it is not
      // recorded as stamped below.
      for (const args of cloneCredentialConfigArgs(this.gitRunner.credentials)) {
        await this.gitRunner.run(this.dir, args).catch((err: unknown) => {
          if (!(args.includes('--unset-all') && (err as GitRunError).exitCode === 5)) credentialsStamped = false;
        });
      }
      fetchedAt = fetchInstant();
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
    this.stampedCredentials = credentialsStamped ? this.credentialFingerprint() : null;
    this.noteFetched(true, fetchedAt);
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
      // No automatic collection: it would run inside whichever worktree's
      // commit tripped it, beside every other worktree's work. The startup
      // phase collects once per boot instead (`maintain`).
      ['config', 'gc.auto', '0'],
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
   * it changed since it was last stamped. As the administrator, as every write
   * to the shared config is. A no-op for a repository not yet made.
   */
  async refreshCredentials(): Promise<void> {
    if (this.stampedCredentials === this.credentialFingerprint() && this.configStamped) return;
    await this.exclusive(async () => {
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
    await this.exclusive(async () => {
      for (const args of argLists) await this.gitRunner.run(cwd, args);
    });
  }

  /** See the contract. `gc --auto` decides for itself whether there is enough loose to pack. */
  async maintain(): Promise<void> {
    try {
      if (!(await this.exists())) return;
      await this.git(['-c', 'gc.auto=6700', 'gc', '--auto', '--quiet'], Math.max(this.gitRunner.defaultTimeoutMs, FIRST_FETCH_TIMEOUT_MS));
    } catch (err) {
      log.warn('garbage collection of the knowledge-base repository failed; it is tried again at the next start:', {
        detail: this.redact(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  /**
   * `at` for a success is when its fetch STARTED: the refs it wrote are at
   * least that fresh, and no fresher — a deletion on the remote while it ran
   * may be missing from them.
   */
  private noteFetched(ok: boolean, at = Date.now()): void {
    this.lastOk = ok;
    if (ok) this.lastSuccessAt = at;
    else this.lastFailureAt = at;
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
   * Throttled by `maxAgeMs` and joined while in flight (ten callers in one
   * tick share one fetch). Not serialized against the worktrees' own git:
   * a fetch writes remote-tracking refs and packs, which git locks itself.
   * Answers whether the remote-tracking refs are provably fresh: this call's
   * fetch (or the one it joined) succeeded, or one succeeded within the
   * window. Never throws; a caller that must not act on stale refs reads the
   * answer.
   */
  async fetch(opts: FetchOptions): Promise<boolean> {
    const now = Date.now();
    if (
      !opts.force &&
      now - this.lastSuccessAt < opts.maxAgeMs &&
      (opts.fetchedSince === undefined || this.lastSuccessAt > opts.fetchedSince)
    ) {
      return true;
    }
    if (this.inFlightFetch) {
      if (opts.fetchedSince === undefined || this.inFlightStartedAt > opts.fetchedSince) return this.inFlightFetch;
      // Started before the caller's instant: its refs may be older than what
      // the caller must see (a branch deleted since). Waited for, then a
      // fetch after the instant is joined or run: forced, so neither the
      // waited-for one's success nor its failure (the backoff) stands in for
      // it. Any fetch in flight now started after the instant, so this ends.
      await this.inFlightFetch;
      return this.fetch({ ...opts, force: true });
    }
    if (!opts.force && opts.failureBackoffMs && now - this.lastFailureAt < opts.failureBackoffMs) {
      return false;
    }
    const generation = this.generation;
    let startedAt = fetchInstant();
    const promise = (async () => {
      startedAt = fetchInstant();
      // A repository not made yet is made here, which fetches it once: that
      // first fetch is this one.
      const existed = await this.exists();
      await this.ensure();
      if (!existed) return;
      await this.git([
        // A transfer that stalls below 1 KB/s for ten seconds is abandoned,
        // so a hung host cannot park every workspace behind it.
        '-c', 'http.lowSpeedLimit=1000',
        '-c', 'http.lowSpeedTime=10',
        ...SAFE_IMPLICIT_FETCH_ARGS,
      ]);
    })()
      .then(
        () => {
          // When this fetch made the repository, ensureHeld() already stamped its
          // own (later) first-fetch start: keep that one.
          if (generation === this.generation) this.noteFetched(true, Math.max(startedAt, this.lastSuccessAt));
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
    this.inFlightStartedAt = startedAt;
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
   * `fetchedSince` (the startup phase, opening every branch) skips asking
   * the remote when the repository's own fetch succeeded, starting after it,
   * and already has `origin/<branch>`: that fetch brought every branch, so
   * opening a hundred branches costs one fetch, not a hundred. A branch it
   * does not know yet is asked for as usual.
   */
  async addWorktree(
    branch: string,
    checkoutDir: string,
    opts: AddWorktreeOptions = {},
  ): Promise<void> {
    await this.ensure();
    {
      // The remote is ASKED for the branch, as a clone of it asked: the
      // repository's tracking ref may be from before the branch moved, or was
      // deleted, on the host. One branch, not the whole remote. Not as the
      // administrator: a fetch may take a while, and git locks what it writes.
      let missing = false;
      const fresh =
        opts.fetchedSince !== undefined &&
        this.lastSuccessAt > 0 &&
        this.lastSuccessAt > opts.fetchedSince &&
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
      // As the administrator, from reading the local ref to the config
      // writes: the worktree list is the one thing git does not lock (a prune
      // beside another branch's `worktree add` can take the entry being
      // made), `worktree add --track` writes the shared config, which git
      // refuses a second writer of, and a `removeWorktree` queued before this
      // section deletes the branch's local ref — read here, it is the ref
      // the add uses, not one read before that removal and gone by then.
      await this.exclusive(async () => {
        const local = await this.revParse(`refs/heads/${branch}`);
        if (missing && !(opts.allowLocalOnly && local !== null)) {
          throw new Error(`Remote branch ${branch} not found in upstream origin`);
        }
        await fs.mkdir(path.dirname(checkoutDir), { recursive: true });
        // A registration left behind by a folder deleted without git (a crash,
        // an operator) would make git refuse the path, or the branch, as taken.
        await this.git(['worktree', 'prune']);
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
  }

  /**
   * Remove the worktree at `checkoutDir` and prune it from the repository,
   * with its branch's local ref: deleting a workspace takes what a deleted
   * clone took. The repository's objects and every other worktree are left
   * exactly as they were. A folder git will not remove (it is not a worktree
   * any more, or is locked) is deleted by hand, then pruned.
   */
  async removeWorktree(checkoutDir: string, branch: string): Promise<void> {
    if (!(await this.exists())) {
      await fs.rm(checkoutDir, { recursive: true, force: true });
      return;
    }
    // As the administrator, the branch delete included: the worktree list
    // is the repository's to serialize (see `addWorktree`), the delete
    // removes the branch's section from the shared config, and an
    // `addWorktree` of the same branch must find the ref either there or
    // gone, not read it and then lose it.
    await this.exclusive(async () => {
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
    if (!(await this.exists())) return;
    // As the administrator, prune and deletes together: the worktree list is
    // the repository's to serialize, and a branch delete writes the shared
    // config (see `removeWorktree`).
    await this.exclusive(async () => {
      await this.git(['worktree', 'prune']);
      for (const branch of branches) {
        if ((await this.revParse(`refs/heads/${branch}`)) === null) continue;
        await this.git(['branch', '-D', '--', branch]).catch(() => undefined);
      }
    });
  }

  /**
   * `git worktree prune`: forget worktrees whose folders are gone. As the
   * administrator: a prune beside a `worktree add` can take the entry being
   * made, before git has marked it as in the making.
   */
  async prune(): Promise<void> {
    if (!(await this.exists())) return;
    await this.exclusive(() => this.git(['worktree', 'prune']));
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
    await this.ensure();
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
  }

  /**
   * Bring what else the full clone at `cloneDir` holds of its own into the
   * repository, under `refs/kb-converted/<workspaceId>/`, before the clone
   * goes: every entry of its stash (`stash/0` the latest), and every local
   * ref but its own branch's and the remote-tracking ones — other local
   * branches, tags — that the repository does not already hold with the same
   * value. Nothing in the clone changes: each object is pushed by its id.
   * Answers the refs written, after checking the repository holds each at the
   * clone's value; throws, the clone untouched, when one cannot be written.
   *
   * The refs are no workspace's: deleting the branch's workspace leaves them,
   * and the repository's collection keeps what they reach.
   */
  async importLocalRefs(cloneDir: string, branch: string, workspaceId: string): Promise<string[]> {
    await this.ensure();
    const inClone = async (args: string[]) => (await this.gitRunner.run(cloneDir, args)).stdout;
    const namespace = `${CONVERTED_REFS}/${workspaceId}`;
    const wanted: { sha: string; dest: string }[] = [];
    let stashTop: string | null = null;
    for (const line of (await inClone(['for-each-ref', '--format=%(objectname) %(refname)'])).split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (!sha || !name) continue;
      if (name === 'refs/stash') { stashTop = sha; continue; }
      if (name.startsWith('refs/remotes/') || name === `refs/heads/${branch}`) continue;
      if ((await this.refValue(name)) === sha) continue;
      if (name.startsWith('refs/heads/') && (await this.refValue(`refs/remotes/origin/${name.slice('refs/heads/'.length)}`)) === sha) continue;
      wanted.push({ sha, dest: `${namespace}/${name.slice('refs/'.length)}` });
    }
    if (stashTop !== null) {
      // Every entry, not only the latest: the older ones are the stash's log.
      // Git reads a log it cannot open (EACCES, EIO) as an empty one and
      // exits 0, so the log is read here first: only an absent one means the
      // stash is its tip alone, and any other failure throws, the clone kept.
      const logFile = path.resolve(cloneDir, (await inClone(['rev-parse', '--git-path', 'logs/refs/stash'])).trim());
      let logged: number;
      try {
        logged = (await fs.readFile(logFile, 'utf8')).split('\n').filter((l) => l.trim() !== '').length;
      } catch (err) {
        if (!isAbsence(err)) throw err;
        logged = 0;
      }
      const entries = (await inClone(['reflog', 'show', '--format=%H', 'refs/stash']))
        .split('\n').map((l) => l.trim()).filter(Boolean);
      if (entries.length !== logged) {
        throw new Error(`the stash log of ${cloneDir} holds ${logged} entries, git read ${entries.length}`);
      }
      if (logged > 0 && entries[0] !== stashTop) {
        throw new Error(`the stash log of ${cloneDir} starts at ${entries[0]}, not at the stash tip ${stashTop}`);
      }
      (logged > 0 ? entries : [stashTop]).forEach((sha, i) => wanted.push({ sha, dest: `${namespace}/stash/${i}` }));
    }
    if (wanted.length === 0) return [];
    await this.gitRunner.run(cloneDir, ['push', '--quiet', '--no-verify', this.dir,
      ...wanted.map(({ sha, dest }) => `+${sha}:${dest}`)]);
    for (const { sha, dest } of wanted) {
      const held = await this.refValue(dest);
      if (held !== sha) throw new Error(`the repository holds ${held ?? 'nothing'} at ${dest} after the import, not ${sha}`);
    }
    return wanted.map(({ dest }) => dest);
  }

  /** The object a ref names, as it is (a tag is not peeled), or null. */
  private async refValue(ref: string): Promise<string | null> {
    try {
      return (await this.git(['rev-parse', '--verify', '--quiet', ref])).trim() || null;
    } catch {
      return null;
    }
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
   * A worktree whose second link cannot be written gets its first one back,
   * so neither link names a place the other does not.
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
        // Both links or neither: a `.git` re-pointed while the record behind
        // it still names the old checkout is a worktree git calls prunable,
        // and a `worktree prune` in the set-aside repository would drop it.
        const before = await fs.readFile(gitfile, 'utf8');
        // Written as the file system names them, as git itself writes them:
        // on Windows a path held by its 8.3 short name (`RUNNER~1`) would
        // otherwise be what `git worktree list` shows.
        const realAdmin = await fs.realpath(admin);
        const realGitfile = path.join(await fs.realpath(worktree), '.git');
        await rewriteFile(gitfile, `gitdir: ${gitPath(realAdmin)}\n`);
        try {
          await rewriteFile(path.join(admin, 'gitdir'), `${gitPath(realGitfile)}\n`);
        } catch (err) {
          await rewriteFile(gitfile, before).catch((backErr: unknown) => {
            log.error(`the .git file of the set-aside worktree ${worktree} could not be restored:`, {
              detail: this.redact(backErr instanceof Error ? backErr.message : String(backErr)),
            });
          });
          throw err;
        }
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
    await this.exclusive(async () => {
      await this.git(['remote', 'set-url', 'origin', url]);
      this.generation++;
      this.lastSuccessAt = 0;
      this.lastFailureAt = 0;
      this.lastOk = null;
      this.lastFailure = null;
    });
  }
}
