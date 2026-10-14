import type { WorkspaceMutex } from '../kb-fs/mutex.js';

/**
 * The knowledge base's one repository, every branch workspace a worktree of
 * it — the contract its consumers (the workspace service, the KB startup
 * phase, the set-aside of a moved repository, the git layer) depend on.
 * `KbRepository` (`kb-repository.ts`) is the implementation, a bare
 * repository driven by the git CLI; the composition root makes ONE and
 * injects it everywhere, so that one fetch serves every workspace and the
 * repository-level reservation is one.
 */

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

export interface AddWorktreeOptions {
  /** A converted clone whose branch was never pushed: its local ref is enough. */
  allowLocalOnly?: boolean;
  /** A conversion: a local ref behind the remote stays where it is. */
  keepLocalTip?: boolean;
  /** Reuse the repository's own fetch when it succeeded this recently and knows the branch. */
  withinFetchWindowMs?: number;
}

export interface IKbRepository {
  /** The bare repository's folder. */
  readonly dir: string;
  /**
   * The mutex the git layer serializes worktree operations under; every
   * repository operation runs under its repository-level reservation.
   */
  readonly mutex: WorkspaceMutex;

  /** Whether the repository is on disk and finished (its first fetch landed). */
  exists(): Promise<boolean>;
  /** Create the repository and fetch it once when it is not there. Throws with git's words, redacted. */
  ensure(): Promise<void>;
  /** Re-stamp the credential helper when the deployment's credential changed. */
  refreshCredentials(): Promise<void>;
  /** Run `git config` writes against the shared configuration, one writer at a time. */
  writeConfig(cwd: string, argLists: readonly string[][]): Promise<void>;
  /** The last time the repository reached the remote and whether it worked; null before any attempt. */
  lastContact(): { at: number; ok: boolean } | null;
  /** Why the last fetch failed, redacted; null when it did not. */
  lastFetchFailure(): string | null;
  /**
   * `git fetch --prune origin`, once for every workspace: throttled, joined
   * while in flight, under the repository reservation. Answers whether the
   * remote-tracking refs are provably fresh. Never throws.
   */
  fetch(opts: FetchOptions): Promise<boolean>;
  /** Forget what this process knows of the repository (it was set aside). */
  forget(): void;
  /** Add the worktree of `branch` at `checkoutDir`, copying no history. */
  addWorktree(branch: string, checkoutDir: string, opts?: AddWorktreeOptions): Promise<void>;
  /** Remove and prune the worktree at `checkoutDir`, with its branch's local ref; nothing else. */
  removeWorktree(checkoutDir: string, branch: string): Promise<void>;
  /** Prune worktrees whose folders were deleted by hand, and drop their branches' local refs. */
  forgetWorktrees(branches: readonly string[]): Promise<void>;
  /** `git worktree prune`. */
  prune(): Promise<void>;
  /** The folders of the repository's worktrees, as git lists them. */
  listWorktrees(): Promise<string[]>;
  /** Import the tip of `branch` from the full clone at `cloneDir` (unpushed commits included); answers the tip. */
  importBranch(cloneDir: string, branch: string): Promise<string>;
  /** The address the repository fetches from, or null when it cannot be read. */
  originUrl(): Promise<string | null>;
  /** Re-link a repository and its worktrees that were moved together; answers the worktrees that could not be. */
  relinkMovedCopy(movedRepository: string, movedWorktrees: readonly string[]): Promise<string[]>;
  /** Point the repository at `url`, forgetting the old address's fetch freshness. */
  setOriginUrl(url: string): Promise<void>;
}
