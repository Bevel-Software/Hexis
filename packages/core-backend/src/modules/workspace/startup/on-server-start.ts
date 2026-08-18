/**
 * The KB startup contract: every migration and scaffolding concern runs here,
 * at the deployment's quiet moments, and nowhere else.
 *
 * There are exactly two occasions, both provably quiet (no user holds a lock,
 * no edit is mid-flight): SERVER BOOT, before routes mount; and FIRST-TIME
 * SETUP COMPLETION, when the branch model is configured through the setup
 * screen — the app is gated shut until exactly that moment. Any later re-run
 * would race live sessions on the very working clones it maintains, which is
 * why there is no retry tick, no lazy per-branch trigger, and no maintenance
 * on runtime branch opens, ever. A failed boot is retried by the container's
 * restart policy — each attempt at boot time, on quiet trees.
 *
 * Failure model, fully fail-closed: the server either completes the phase or
 * does not serve. An UNHANDLED throw from a step stops the boot — the same
 * contract a DB migration has. A failure the author knows is survivable must
 * be DECLARED via the result. `KB_SAFE_BOOT=1` is the break-glass demotion
 * (see the runner).
 */

export interface OnServerStart {
  /** Shown in logs and error messages: "groups-to-plugins", "template-files", … */
  readonly name: string;
  run(ctx: ServerStartContext): Promise<StepResult>;
}

/**
 * What the runner should do next. Every declared outcome asserts "the tree is
 * in a state later steps can safely run against".
 */
export type StepResult =
  /** Fully done; declared ops apply. "Nothing to do" is `ok` with no ops. */
  | { outcome: 'ok' }
  /**
   * Incomplete but VALID: declared ops still apply; the remainder is named
   * and logged. The migration's refused conversions are exactly this.
   */
  | { outcome: 'partial'; reason: string }
  /**
   * Did not complete: declared ops are discarded UNAPPLIED — the tree is
   * untouched by construction, not by revert — and later steps continue.
   */
  | { outcome: 'skipped'; reason: string }
  /** Serving would be worse than being down. The deliberate kill switch. */
  | { outcome: 'stopBoot'; message: string };

export interface ServerStartContext {
  /** The resolved template directory this build ships. */
  readonly templateDir: string;
  /** Handles are lazy — the clone happens on first `repoDir()`. */
  defaultBranch(): Promise<KbBranch>;
  protectedBranches(): Promise<KbBranch[]>;
  /**
   * Every branch on the remote, drafts included — and WRITABLE like any
   * other: with maintenance applied uniformly at the quiet moment, migrating
   * a draft alongside its target is what keeps its change-request diff down
   * to the user's own changes. (The lazy era's read-only rule guarded
   * against ASYMMETRIC application; uniform application inverts it — a
   * stale draft against a migrated target diffs by the whole rename.)
   */
  allBranches(): Promise<KbBranch[]>;
}

/**
 * One branch's working copy, with buffered writes. Steps never touch the
 * disk: they READ via `repoDir()` and DECLARE operations, which the runner —
 * the only writer — applies when the step returns `ok`/`partial` (so the next
 * step sees the real, updated tree) and discards on `skipped`. The applier
 * enforces the write layer's containment contract once — repo-relative
 * paths, no escapes, no symlinks — instead of every step getting raw fs
 * right.
 */
export interface KbBranch {
  readonly name: string;
  readonly isProtected: boolean;
  /** Absolute path of the checked-out clone; clone-if-absent happens here. */
  repoDir(): Promise<string>;
  /** Declare a file's full content at a repo-relative path. */
  write(path: string, content: string | Uint8Array): void;
  /** Declare a relocation — file or whole directory (the Groups→Plugins rename is one op). */
  move(from: string, to: string): void;
  /** Declare a file's removal. */
  remove(path: string): void;
  /** One honest line per logical change — the branch's commit message is built from these. */
  note(line: string): void;
}
