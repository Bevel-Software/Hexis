/**
 * The knowledge base's one repository, every branch workspace a worktree of
 * it — the contract its consumers (the workspace service, the KB startup
 * phase, the set-aside of a moved repository, the git layer) depend on.
 * `KbRepository` (`kb-repository.ts`) is the implementation, a bare
 * repository driven by the git CLI; the composition root makes ONE and
 * injects it everywhere, so that one fetch serves every workspace and the
 * repository's administration — its creation, the writes to its one config
 * file, its worktree list, a set-aside — is serialized in one place.
 *
 * Nothing else is serialized by the application: git was built for many
 * worktrees of one repository, and protects the refs, `packed-refs` and the
 * object store with its own locks. The worktree list (`worktrees/`) it does
 * not lock, which is why adding, removing and pruning worktrees are
 * administration here. Two worktrees run side by side, as two developers'
 * worktrees of one repository do.
 */

export interface FetchOptions {
  /** A fetch that SUCCEEDED this recently is fresh enough; nothing runs. */
  maxAgeMs: number;
  /**
   * An instant (`fetchInstant()`): a success counts as fresh only when
   * its fetch started after it, however young it is (a fetch from before a listing may lack
   * what the listing saw). A fetch in flight that started before it is
   * waited for, not joined, and a fresh one runs.
   */
  fetchedSince?: number;
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
  /**
   * Reuse the repository's own fetch when it started after this instant
   * (`fetchInstant()`)
   * and knows the branch. An instant, not an age: it is compared inside the
   * reservation, so time spent waiting for it cannot age a fetch out.
   */
  fetchedSince?: number;
}

export interface IKbRepository {
  /** The bare repository's folder. */
  readonly dir: string;
  /**
   * Run `fn` as the repository's one administrator for its duration: no
   * creation of the repository, no write to its one config file (git refuses
   * a second writer of it rather than waiting), no change to its worktree
   * list (which git does not lock: a prune beside a `worktree add` can take
   * the entry being made), and no set-aside runs beside it. Git operations
   * in the worktrees are not held back — git's own locks cover them — so a
   * caller that moves the repository's folders holds those off itself (the
   * startup phase runs before anything is served; the workspace service
   * wraps a set-aside in what surrounds one). Never nested: `fn` must not
   * call `exclusive` again, nor a method that does (`ensure`, `addWorktree`,
   * `removeWorktree`, `prune`, the config writes).
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;

  /** Whether the repository is on disk and finished (its first fetch landed). */
  exists(): Promise<boolean>;
  /** Create the repository and fetch it once when it is not there. Throws with git's words, redacted. */
  ensure(): Promise<void>;
  /** Re-stamp the credential helper when the deployment's credential changed. */
  refreshCredentials(): Promise<void>;
  /** Run `git config` writes against the shared configuration, one writer at a time. */
  writeConfig(cwd: string, argLists: readonly string[][]): Promise<void>;
  /**
   * Garbage-collect the repository when git finds it worth it (`gc --auto`
   * with git's default thresholds). Automatic collection is off on the
   * repository — a commit in one worktree would otherwise collect beside
   * every other worktree's work — so the startup phase runs this once, when
   * nothing else does. Never throws.
   */
  maintain(): Promise<void>;
  /** The last time the repository reached the remote and whether it worked; null before any attempt. */
  lastContact(): { at: number; ok: boolean } | null;
  /** Why the last fetch failed, redacted; null when it did not. */
  lastFetchFailure(): string | null;
  /**
   * `git fetch --prune origin`, once for every workspace: throttled, and
   * joined while in flight. Answers whether the remote-tracking refs are
   * provably fresh. Never throws.
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
  /**
   * Import the full clone's stash entries and its other local refs (not its own
   * branch, not remote-tracking ones) under `refs/kb-converted/<workspaceId>/`,
   * leaving the clone as it was; answers the refs written.
   */
  importLocalRefs(cloneDir: string, branch: string, workspaceId: string): Promise<string[]>;
  /** The address the repository fetches from, or null when it cannot be read. */
  originUrl(): Promise<string | null>;
  /** Re-link a repository and its worktrees that were moved together; answers the worktrees that could not be. */
  relinkMovedCopy(movedRepository: string, movedWorktrees: readonly string[]): Promise<string[]>;
  /** Point the repository at `url`, forgetting the old address's fetch freshness. */
  setOriginUrl(url: string): Promise<void>;
}
