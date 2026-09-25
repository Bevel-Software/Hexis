import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../../shared/logging.js';

// `startupLog` rather than `log`: `retryUntilMaintained` takes a `log`
// callback of its own, and a module logger of the same name would be
// shadowed exactly where it is meant to be the default.
const startupLog = logger('kb-startup');
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { KbBranch, OnServerStart, ServerStartContext } from './on-server-start.js';
import { git, lsRemoteHeads, stampIdentity, withTempDir } from './kb-git.js';
import { GitRunError, type IGitRunner } from '../../../shared/git.contract.js';
import {
  ClassifiedFailure,
  classifyGitFailure,
  failureOf,
  gitFailure,
  type GitFailure,
} from '../../../shared/git-failure.js';
import { redactSecret, urlQuerySecrets } from '../../../shared/redact-secret.js';

/**
 * The KB startup phase: run every registered {@link OnServerStart} step, in
 * order, against lazily-cloned branch handles, then land one commit per
 * dirty branch. Invoked at the deployment's two quiet moments — boot (before
 * routes mount) and first-time setup completion (the app is gated shut until
 * then) — and never again while the process serves.
 *
 * Fully fail-closed: any failure this phase cannot DECLARE (an unhandled
 * step throw, an unreachable remote, a clone that will not come down, a
 * refused write) throws out of `runAll` and stops the boot. The container's
 * restart policy is the retry — each attempt at boot time on quiet trees —
 * so an environmental failure converges without a human the moment the
 * environment returns. The one carve-out: a push rejected because a
 * concurrent replica won rolls back and continues; the winner already landed
 * the same idempotent changes, and stopping the loser would make every
 * multi-replica deploy flappy by design.
 *
 * `KB_SAFE_BOOT=1` is the break-glass demotion: on the first failure the
 * phase resets every uncommitted tree, abandons the rest of the phase, and
 * lets the server boot UNMAINTAINED so an admin can get in and rescue —
 * loudly, at boot and in the log, because an env var outlives the emergency.
 */

export interface KbStartupRunnerOptions {
  /**
   * How git is run — see `shared/git.contract.ts`. It carries the credentials
   * every command of the phase authenticates with, and the token the phase
   * scrubs from every message it throws or logs.
   */
  gitRunner: IGitRunner;
  kbRepoUrl: () => string;
  workspacesRoot: string;
  kbDirName: string;
  templateDir: string;
  defaultBranch: () => string;
  protectedBranches: () => readonly string[];
  /** Admins written into a freshly-seeded repo's roles.yaml (`ADMIN_EMAIL`). */
  seedAdminEmails: readonly string[];
  /** The ordered step chain — core's steps plus whatever the distribution appends. */
  steps: readonly OnServerStart[];
  /** The empty-remote seed commit builder (template tree + roles.yaml), injected
      so the runner stays free of template knowledge. Receives the temp dir to
      fill; the runner handles init/commit/push around it. Resolves to the
      repo-relative paths the builder GENERATED itself (rather than copied from
      the template) — the runner force-adds them after `git add -A`, so a
      template `.gitignore` rule can never silently drop a required seed file
      from the commit. */
  buildSeedTree: (dir: string) => Promise<string[]>;
}

/**
 * The remote could not be reached or refused us: a host that is down, a DNS
 * name that does not resolve, a token that was rotated. Told apart from every
 * other way the phase can fail because it is the one that says nothing about
 * the knowledge base — what we would write is not known to be wrong, we
 * simply cannot get there right now — and so the one a boot may survive:
 * the deployment comes up gated and unmaintained, and tries again.
 *
 * A {@link ClassifiedFailure} that keeps the classification the remote
 * contact already produced when it has one — `credentials-rejected`,
 * `not-found` — and is `unreachable` only when nothing more specific is
 * known. The setup screen shows the remediation for THAT kind, the same one a
 * setup-time connection test shows for the same token: a rotated token reads
 * as "the host rejected the credentials", not as a network the server cannot
 * reach, and the retry loop is not left re-dialing a host that will never
 * accept it.
 */
export class KbRemoteUnreachableError extends ClassifiedFailure {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(
      message,
      opts?.cause instanceof ClassifiedFailure ? opts.cause.failure : gitFailure('unreachable'),
      opts,
    );
    this.name = 'KbRemoteUnreachableError';
  }
}

export interface RetryOptions {
  /** First wait before trying again. Default 30s. */
  initialDelayMs?: number;
  /** The wait doubles up to this. Default 10 minutes. */
  maxDelayMs?: number;
  /** Test seam — defaults to `setTimeout` wrapped as a promise, unref'd. */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export class KbStartupRunner {
  constructor(private readonly opts: KbStartupRunnerOptions) {}

  /** The run in progress, so two invokers share one rather than racing clones. */
  private inFlight: Promise<void> | null = null;
  /** Why the last run failed, redacted; null after a run that finished. */
  private failure: string | null = null;
  /** The same failure classified — what the setup screen shows. */
  private failureKind: GitFailure | null = null;
  /** The phase's last attempt to reach the remote — for the readiness answer. */
  private remoteContact: { at: number; ok: boolean } | null = null;

  /**
   * {@link redactSecret} plus the token in effect, which may never have reached
   * the environment. Tokens, URL userinfo and URL query strings go — and the
   * configured remote's own query values (a presigned remote's credential) are
   * named as secrets too, so they are scrubbed even where git's text carries
   * them without the URL around them.
   */
  private redact(text: string): string {
    return redactSecret(text, [this.opts.gitRunner.credentials.token(), ...urlQuerySecrets(this.opts.kbRepoUrl())]);
  }

  /**
   * When this runner last tried the remote and whether it answered. The
   * phase's `ls-remote` is often the FIRST contact a boot makes, and on a
   * gated deployment the only one, so a readiness answer that read only the
   * workspace layer's fetches would call an unreachable remote "ok".
   */
  lastRemoteContact(): { at: number; ok: boolean } | null {
    return this.remoteContact;
  }

  /**
   * Why the most recent run failed, or null when the last run finished — the
   * gate reads this so a boot that survived an unreachable remote keeps the
   * deployment shut until a later run succeeds, exactly as a failed
   * setup-time run does.
   */
  lastFailure(): string | null {
    return this.failure;
  }

  /** The most recent failure in the terms an admin can act on; null when the last run finished. */
  lastFailureKind(): GitFailure | null {
    return this.failureKind;
  }

  /**
   * Run the whole phase. Throws to stop the boot; returns normally when the
   * KB is fully maintained (or safe boot abandoned the phase, loudly).
   *
   * One run at a time: a second caller — the setup save while a background
   * retry is under way, or the reverse — joins the run in progress rather
   * than starting another over the same clones.
   */
  runAll(): Promise<void> {
    this.inFlight ??= this.runAllOnce()
      .then(() => {
        this.failure = null;
        this.failureKind = null;
      })
      .catch((err: unknown) => {
        this.failure = this.redact(err instanceof Error ? err.message : String(err));
        this.failureKind = failureOf(err);
        throw err;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /**
   * Keep running the phase until it finishes, for a boot that survived an
   * unreachable remote. Safe to run while the process serves, because the
   * deployment is GATED for as long as `lastFailure` stands: no session can
   * be holding a working clone the phase would race. Doubles the wait up to a
   * ceiling — a host that is down for an hour is asked every ten minutes,
   * not every thirty seconds — and stops on the first success, or on a
   * failure that is NOT the remote being unreachable: that one says the
   * knowledge base itself is wrong, and asking again will not change it.
   * The timer never holds the process open.
   */
  retryUntilMaintained(opts: RetryOptions = {}): { stop(): void } {
    const initial = opts.initialDelayMs ?? 30_000;
    const max = opts.maxDelayMs ?? 10 * 60_000;
    const log = opts.log ?? ((message: string) => startupLog.warn(message));
    const sleep =
      opts.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms).unref();
        }));
    let stopped = false;

    // A rejected token is not worth asking again with: the host answers the
    // same until the token changes, and the setup save that changes it runs
    // the phase itself — while re-dialing with a dead token is what gets it
    // rate-limited or locked. Such a boot still survives (the deployment
    // comes up gated, showing that failure); it just is not re-dialed on a
    // timer. Everything else the boot survived IS asked again: a host that
    // could not be reached comes back, and a repository that was "not found"
    // appears when it is created or when the token is granted access to it —
    // neither needs a settings change on this side.
    const worthRetrying = () => this.failureKind?.kind !== 'credentials-rejected';
    const stopOnStanding = () => {
      log(
        `the retry stopped on a failure that asking again cannot change — ` +
          `saving the setup form retries once it is fixed: ${this.failure ?? 'unknown failure'}`,
      );
    };

    void (async () => {
      let delay = initial;
      if (this.failure !== null && !worthRetrying()) return stopOnStanding();
      while (!stopped) {
        await sleep(delay);
        // Another caller — the setup save — may have finished the phase while
        // this loop slept. The deployment is open then, sessions may hold
        // clones, and one more run here would be maintenance over live work.
        if (stopped || this.failure === null) return;
        // Or it may have FAILED the phase with a rejected token while this
        // loop slept: the standing failure is then one a retry cannot change,
        // and dialing it again is what gets the token rate-limited.
        if (!worthRetrying()) return stopOnStanding();
        try {
          await this.runAll();
          log('the remote is reachable again and the knowledge base is maintained — the deployment is open.');
          return;
        } catch (err) {
          // Stopped by either: a failure that is no longer the remote at all
          // (the knowledge base itself is wrong — asking again will not change
          // it), or a remote answer that a retry cannot change (see above).
          if (!(err instanceof KbRemoteUnreachableError) || !worthRetrying()) return stopOnStanding();
          delay = Math.min(delay * 2, max);
          log(`remote still unreachable; trying again in ${Math.round(delay / 1000)}s`);
        }
      }
    })();

    return {
      stop() {
        stopped = true;
      },
    };
  }

  private async runAllOnce(): Promise<void> {
    // An empty default branch IS the unconfigured model (see `KbContext`).
    if (!this.opts.defaultBranch()) {
      startupLog.info('branch model not configured yet — phase skipped until setup completes.');
      return;
    }
    // A branch model without a repository URL is a PARTIALLY set-up deployment
    // (the two can arrive on different saves, and a restart can land between
    // them). There is nothing to maintain yet, and running anyway would
    // `ls-remote ''` — a boot that fails forever while the setup screen it
    // needs stays unreachable. The setup-completion invocation catches up the
    // moment the URL exists.
    if (this.opts.kbRepoUrl().trim() === '') {
      startupLog.info('KB repository URL not configured yet — phase skipped until setup completes.');
      return;
    }
    const safeBoot = process.env.KB_SAFE_BOOT === '1';
    if (safeBoot) {
      startupLog.warn(
        'KB_SAFE_BOOT=1 — failures will abandon maintenance instead of stopping the boot. ' +
          'Remove the variable once the rescue is done.',
      );
    }

    const phaseStart = Date.now();
    const handles = new Map<string, BranchHandle>();
    // ONE safe-boot boundary around the whole phase — remote preparation, the
    // step loop, AND the finalize commits. Rescue mode must be able to reset
    // and boot whichever of them fails; a boundary around the step loop alone
    // would let an ensureRemote or finalize failure stop the very boot
    // KB_SAFE_BOOT exists to allow.
    try {
      // A URL carrying userinfo (`https://user:token@host/…`) is operator
      // error, and fail-closed means THROWING, not skipping: the embedded
      // credential would ride into argv on every git invocation and be
      // visible in process listings. Checked INSIDE the boundary so
      // KB_SAFE_BOOT can still bring the server up over a persisted bad URL
      // — the rescue never invokes git. (The message never quotes the URL.)
      if (/\/\/[^/]*@/.test(this.opts.kbRepoUrl())) {
        throw new Error(
          'The KB repository URL embeds credentials (user:token@host), which would be visible in ' +
            'process listings. Remove them from the URL and configure the token via the setup ' +
            'screen or GITHUB_TOKEN instead.',
        );
      }
      const heads = await this.ensureRemote();
      const ctx = this.buildContext(heads, handles);

      for (const step of this.opts.steps) {
        const started = Date.now();
        const result = await step.run(ctx).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          const raw = `KB startup step "${step.name}" failed: ${msg}`;
          // A git failure inside the step was classified where git's words were
          // still whole; anything else is read here, before the scrub.
          const failure = err instanceof ClassifiedFailure ? err.failure : classifyGitFailure(raw);
          throw new ClassifiedFailure(this.redact(raw), failure, { cause: err });
        });
        const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
        if (result.outcome === 'stopBoot') {
          // Redacted like every other exit: the message reaches the log.
          const raw = `KB startup step "${step.name}" stopped the boot: ${result.message}`;
          throw new ClassifiedFailure(this.redact(raw), classifyGitFailure(raw));
        }
        if (result.outcome === 'skipped') {
          startupLog.warn(`${step.name}: skipped — ${result.reason} (${took})`);
          for (const h of handles.values()) h.discardBuffer();
          continue;
        }
        // Counted before applying — applyBuffer drains the buffers.
        let changes = 0;
        let branches = 0;
        for (const h of handles.values()) {
          const n = h.pendingOpCount();
          if (n > 0) {
            changes += n;
            branches++;
          }
        }
        const scope =
          changes === 0
            ? 'no changes'
            : `${changes} change${changes === 1 ? '' : 's'} on ${branches} branch${branches === 1 ? '' : 'es'}`;
        if (result.outcome === 'partial') {
          startupLog.warn(`${step.name}: partial — ${result.reason} (${scope}, ${took})`);
        } else {
          // One line per step even when nothing happened: a silent phase and a
          // step that never ran look identical from the boot log otherwise.
          startupLog.info(`${step.name}: ok — ${scope} (${took})`);
        }
        for (const h of handles.values()) await h.applyBuffer();
      }

      for (const h of handles.values()) {
        await this.finalize(h);
      }
    } catch (err) {
      // Every exit carries a scrubbed message: the port scrubs only what the
      // environment holds, and a token saved on the setup screen is the one
      // this runner alone knows about. The classification rides along, read
      // from text no scrub had touched.
      const msg = this.redact(err instanceof Error ? err.message : String(err));
      if (!safeBoot) {
        // An unreachable remote keeps its own type: it is the one failure a
        // boot survives, and the callers tell it apart by that type.
        if (err instanceof KbRemoteUnreachableError) throw err;
        throw new ClassifiedFailure(msg, failureOf(err), { cause: err });
      }
      startupLog.error('SAFE BOOT: abandoning the phase after a failure — the KB is UNMAINTAINED this run.', {
        detail: msg,
      });
      // Reset only DIRTY handles — ones an apply at least began on (the mark
      // is set before the first op, so a mid-apply failure is covered). A
      // clone a step merely read must NOT be swept: sweeping it would disturb
      // pre-existing state in a surviving working clone that no op ever
      // touched. Each reset targets the handle's recorded pre-phase sha, so
      // even a created-but-unpushed finalize commit is rolled back.
      for (const h of handles.values()) await h.resetUncommitted().catch(() => {});
      return;
    }
    startupLog.info(`phase complete (${((Date.now() - phaseStart) / 1000).toFixed(1)}s).`);
  }

  /**
   * Remote preparation — runner machinery, not a step, because every remote
   * failure mode here is the runner's to own: an EMPTY remote gets the full
   * seed commit pushed to every protected branch; missing protected refs are
   * created from the best base. Returns the remote's head names (post-seed).
   */
  private async ensureRemote(): Promise<Set<string>> {
    const url = this.opts.kbRepoUrl();
    // The first question asked of the remote, and the one that answers
    // "can we get there at all". Everything after it — seeding, pushing —
    // fails for reasons of ours; this fails for reasons of the host's.
    let heads: Set<string>;
    try {
      heads = await lsRemoteHeads(this.opts.gitRunner, url);
      this.remoteContact = { at: Date.now(), ok: true };
    } catch (err) {
      // Git that never ran — no executable, a spawn refused — is a fact about
      // this host, not the remote, and retrying the remote would not change
      // it: that failure stops the boot with its own words. What git itself
      // reported (an exit) or a deadline is the remote's answer, and survivable.
      // The port's error is the classified failure's cause (see `kb-git.ts`).
      const run = err instanceof ClassifiedFailure ? err.cause : err;
      if (run instanceof GitRunError && run.exitCode === undefined && !run.timedOut) throw err;
      this.remoteContact = { at: Date.now(), ok: false };
      throw new KbRemoteUnreachableError(
        `The knowledge-base remote could not be reached: ${this.redact(
          err instanceof Error ? err.message : String(err),
        )}`,
        { cause: err },
      );
    }
    const protectedBranches = this.opts.protectedBranches();
    const defaultBranch = this.opts.defaultBranch();

    if (heads.size === 0) {
      if (this.opts.seedAdminEmails.length === 0) {
        throw new Error(
          'KB remote is empty and cannot be seeded: no initial Admin was supplied (ADMIN_EMAIL).',
        );
      }
      const seededByOther = await withTempDir(async (dir) => {
        await git(this.opts.gitRunner, dir, ['init', '-b', defaultBranch]);
        await stampIdentity(this.opts.gitRunner, dir);
        const generated = await this.opts.buildSeedTree(dir);
        await git(this.opts.gitRunner, dir, ['add', '-A']);
        // The template may ship a `.gitignore` whose rules happen to match a
        // GENERATED seed file (roles.yaml, a reserved root's .gitkeep) —
        // `add -A` would silently drop it from the seed commit. Force-add
        // exactly what the builder generated; `-f` on an already-staged path
        // is a no-op.
        if (generated.length > 0) await git(this.opts.gitRunner, dir, ['add', '-f', '--', ...generated]);
        await git(this.opts.gitRunner, dir, ['commit', '-m', 'Seed knowledge base from Bevel template']);
        for (const b of protectedBranches) {
          if (b !== defaultBranch) await git(this.opts.gitRunner, dir, ['branch', b]);
        }
        await git(this.opts.gitRunner, dir, ['remote', 'add', 'origin', url]);
        try {
          await git(this.opts.gitRunner, dir, ['push', '-u', 'origin', ...protectedBranches]);
          return null;
        } catch (err) {
          // Two replicas racing to seed the same empty remote: both saw it
          // empty, one push landed first, the loser's is rejected. ONE re-read
          // decides — if every protected branch now exists, the loser accepts
          // the winner's work; anything less is a real push failure and
          // rethrows. Ref EXISTENCE is deliberately the whole test — content
          // identity is not required, because the steps that follow enforce
          // the required scaffolding on every protected branch regardless of
          // who seeded. A foreign seed is just an "existing remote"
          // discovered late, the same contract as a repo populated before
          // boot.
          const reread = await lsRemoteHeads(this.opts.gitRunner, url);
          if (protectedBranches.every((b) => reread.has(b))) return reread;
          throw err;
        }
      });
      if (seededByOther) {
        startupLog.info(
          'seed push rejected — another replica seeded the remote first; continuing with its branches.',
        );
        return seededByOther;
      }
      startupLog.info(`seeded empty KB remote with branches: ${protectedBranches.join(', ')}`);
      return new Set(protectedBranches);
    }

    const base = heads.has(defaultBranch)
      ? defaultBranch
      : (protectedBranches.find((b) => heads.has(b)) ?? [...heads].sort()[0]!);
    for (const b of protectedBranches) {
      if (heads.has(b)) continue;
      await withTempDir(async (dir) => {
        await git(this.opts.gitRunner, dir, ['clone', '--depth', '1', '-b', base, url, 'seed']);
        await git(this.opts.gitRunner, path.join(dir, 'seed'), ['push', 'origin', `HEAD:refs/heads/${b}`]);
      });
      heads.add(b);
      startupLog.info(`created missing protected branch "${b}" from "${base}"`);
    }
    return heads;
  }

  private buildContext(heads: Set<string>, handles: Map<string, BranchHandle>): ServerStartContext {
    const protectedSet = new Set(this.opts.protectedBranches());
    const handleFor = (branch: string): BranchHandle => {
      let h = handles.get(branch);
      if (!h) {
        h = new BranchHandle(
          branch,
          protectedSet.has(branch),
          () => this.ensureClone(branch),
          this.opts.gitRunner,
        );
        handles.set(branch, h);
      }
      return h;
    };
    return {
      templateDir: this.opts.templateDir,
      defaultBranch: async () => handleFor(this.opts.defaultBranch()),
      protectedBranches: async () => this.opts.protectedBranches().map(handleFor),
      allBranches: async () => [...heads].sort().map(handleFor),
    };
  }

  /**
   * The branch's working copy at the runtime layout
   * (`<workspacesRoot>/<id>/<kbDirName>`), so the workspace service finds it
   * on disk afterwards. A surviving clone is fast-forwarded to origin when
   * that is a pure fast-forward; a clone that is AHEAD (a crash before push
   * left committed work) is left alone — maintenance lands on top and the
   * push either carries both or rejects and rolls back, and the pending-
   * commit recovery owns that work, not this phase.
   */
  private async ensureClone(branch: string): Promise<string> {
    const workspaceDir = path.join(this.opts.workspacesRoot, workspaceIdForBranch(branch));
    const repoDir = path.join(workspaceDir, this.opts.kbDirName);
    const hasGit = await fs.access(path.join(repoDir, '.git')).then(() => true, () => false);
    if (!hasGit) {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.rm(repoDir, { recursive: true, force: true });
      await git(this.opts.gitRunner, workspaceDir, ['clone', '-b', branch, this.opts.kbRepoUrl(), repoDir]);
      await git(this.opts.gitRunner, repoDir, ['config', 'core.longpaths', 'true']);
      await stampIdentity(this.opts.gitRunner, repoDir);
      return repoDir;
    }
    await git(this.opts.gitRunner, repoDir, ['fetch', 'origin', branch]);
    const local = (await git(this.opts.gitRunner, repoDir, ['rev-parse', 'HEAD'])).trim();
    const remote = (await git(this.opts.gitRunner, repoDir, ['rev-parse', `origin/${branch}`])).trim();
    if (local !== remote) {
      const mergeBase = (await git(this.opts.gitRunner, repoDir, ['merge-base', 'HEAD', `origin/${branch}`])).trim();
      if (mergeBase === local) {
        await git(this.opts.gitRunner, repoDir, ['reset', '--hard', `origin/${branch}`]);
      }
      // Ahead or diverged: committed-but-unpushed work lives here; not ours to discard.
    }
    return repoDir;
  }

  /** One commit per dirty branch; push; the replica carve-out on rejection. */
  private async finalize(h: BranchHandle): Promise<void> {
    if (!h.dirty) return;
    const repoDir = await h.repoDir();
    await stampIdentity(this.opts.gitRunner, repoDir);
    // Drop any PRE-EXISTING index state first (a crashed tool may have left
    // edits staged): `git commit` publishes the whole index, and the phase
    // must commit exactly its own staged set. The edits stay in the working
    // tree, unstaged and unpublished — preserved, not adopted.
    await git(this.opts.gitRunner, repoDir, ['reset', '-q']);
    // Stage ONLY the paths the phase's ops touched — sources and targets both
    // (a move's `from` and a remove's path stage as deletions; `add -A -- <path>`
    // handles a deleted path, `-f` handles one a branch `.gitignore` matches).
    // Deliberately NOT `add -A` on the whole tree: pre-existing uncommitted
    // dirt in a reused clone is not this phase's work — it stays out of the
    // phase's commit and remains in the tree, untouched.
    //
    // A pathspec matching nothing is an error, so a path is included only when
    // it exists on disk OR git knows it (`ls-files` non-empty — a tracked path
    // whose deletion must be staged). A path failing both was never tracked
    // and no longer exists: nothing to stage.
    const touched: string[] = [];
    for (const rel of h.appliedPaths()) {
      const onDisk = await fs.access(path.join(repoDir, rel)).then(() => true, () => false);
      if (!onDisk) {
        const known = (await git(this.opts.gitRunner, repoDir, ['ls-files', '--', `:(literal)${rel}`])).trim();
        if (known === '') continue;
      }
      touched.push(rel);
    }
    // `:(literal)` — these are file paths, not pathspecs; chunked so a large
    // migration cannot overflow the platform's argv limit.
    for (let i = 0; i < touched.length; i += 100) {
      await git(this.opts.gitRunner, repoDir, [
        'add',
        '-A',
        '-f',
        '--',
        ...touched.slice(i, i + 100).map((rel) => `:(literal)${rel}`),
      ]);
    }
    // Exit 0 = nothing staged: the ops converged to no byte changes. (An
    // errored diff reads as "something staged"; a genuinely broken repo then
    // fails loudly at commit rather than being silently skipped here.)
    const nothingStaged = await git(this.opts.gitRunner, repoDir, ['diff', '--cached', '--quiet']).then(
      () => true,
      () => false,
    );
    if (nothingStaged) return;
    // The commit this phase is about to add, remembered so the rollback below
    // can undo exactly it — and ONLY it. Resetting to origin/<name> instead
    // would also nuke a pre-existing committed-but-unpushed (AHEAD) commit
    // that ensureClone deliberately preserved.
    const preCommit = (await git(this.opts.gitRunner, repoDir, ['rev-parse', 'HEAD'])).trim();
    await git(this.opts.gitRunner, repoDir, ['commit', '-m', h.commitMessage()]);
    try {
      await git(this.opts.gitRunner, repoDir, ['push', 'origin', `HEAD:refs/heads/${h.name}`]);
      startupLog.info(`${h.name}: ${h.commitSubject()}`);
      // Committed AND pushed: nothing of the phase remains uncommitted here,
      // so a LATER branch's failure under KB_SAFE_BOOT must not rewind this
      // clone to its pre-phase sha — that would leave it behind what origin
      // already holds.
      h.dirty = false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The carve-out is ONLY for a push the remote refused as stale — a
      // concurrent replica won the race, and its pass made the same idempotent
      // changes. Git spells that refusal `! [rejected] … (non-fast-forward)`
      // or `… (fetch first)`; the regex matches exactly those two markers.
      // Deliberately NOT the generic `failed to push some refs` / `[rejected]`
      // trailers: a pre-receive hook decline (branch protection on the KB
      // repo, say) prints those too, and that is a policy refusal every boot
      // would hit — it re-throws like auth or network failures (stopping the
      // boot, or demoted to abandon under KB_SAFE_BOOT like every failure).
      if (!/non-fast-forward|fetch first/i.test(msg)) {
        throw err;
      }
      startupLog.warn(`${h.name}: push rejected (concurrent replica?) — rolling back local commit.`, {
        detail: this.redact(msg),
      });
      await git(this.opts.gitRunner, repoDir, ['reset', '--hard', preCommit]).catch(() => {});
    }
  }
}

type BufferedOp =
  | { kind: 'write'; path: string; content: string | Uint8Array }
  | { kind: 'move'; from: string; to: string }
  | { kind: 'remove'; path: string };

/**
 * The {@link KbBranch} implementation: a lazy clone plus an op buffer. Ops AND
 * notes accumulate while a step runs; the RUNNER applies both (`applyBuffer`)
 * on `ok`/`partial` and drops both (`discardBuffer`) on `skipped` — a skipped
 * step's notes must never decorate a commit made of other steps' changes.
 * Applied ops mark the handle dirty; kept notes accumulate across steps into
 * one commit.
 */
class BranchHandle implements KbBranch {
  constructor(
    readonly name: string,
    readonly isProtected: boolean,
    cloneOnce: () => Promise<string>,
    private readonly gitRunner: IGitRunner,
  ) {
    this.clone = lazyOnce(async () => {
      const dir = await cloneOnce();
      // The rollback anchor, recorded ONCE as the clone materializes: a fresh
      // clone's HEAD, or a surviving clone's pre-phase state (post the
      // fast-forward ensureClone may have applied). For the empty-remote seed
      // the handle clones AFTER seeding, so HEAD is the seed commit — correct.
      // resetUncommitted resets to THIS sha rather than HEAD, so a finalize
      // commit that was created but failed to push rolls back too instead of
      // surviving as a stranded local commit no later boot would ever push.
      this.prePhaseSha = (await git(this.gitRunner, dir, ['rev-parse', 'HEAD'])).trim();
      return dir;
    });
  }

  private readonly clone: () => Promise<string>;
  /** HEAD as of clone time — the safe-boot rollback's anchor (see the constructor). */
  private prePhaseSha: string | null = null;
  private buffer: BufferedOp[] = [];
  /** The CURRENT step's notes — kept or discarded with its ops. */
  private noteBuffer: string[] = [];
  /** Notes of applied steps, in order — the commit message's material. */
  private notes: string[] = [];
  /**
   * Repo-relative paths the ops touched — SOURCES and TARGETS both: writes
   * recorded BEFORE executing (a failed write can leave a partial file the
   * rollback must clean), move destinations AFTER (a failed rename leaves its
   * target untouched — see the note at the rename), and a move's `from` and a
   * remove's path unconditionally at apply time — finalize stages exactly
   * this set, and staging a deletion is what `add -A -- <path>` does.
   */
  private readonly applied = new Set<string>();
  dirty = false;

  repoDir(): Promise<string> {
    return this.clone();
  }
  write(p: string, content: string | Uint8Array): void {
    this.buffer.push({ kind: 'write', path: p, content });
  }
  move(from: string, to: string): void {
    this.buffer.push({ kind: 'move', from, to });
  }
  remove(p: string): void {
    this.buffer.push({ kind: 'remove', path: p });
  }
  note(line: string): void {
    this.noteBuffer.push(line);
  }

  discardBuffer(): void {
    this.buffer = [];
    this.noteBuffer = [];
  }

  /** Apply buffered ops in declaration order, each path contained to the clone. */
  async applyBuffer(): Promise<void> {
    // The step's notes are kept even when it declared no ops — an advisory
    // note (e.g. "both roots exist, merge by hand") surfaces in a commit only
    // if a later step dirties the branch, exactly as before.
    if (this.noteBuffer.length > 0) {
      this.notes.push(...this.noteBuffer);
      this.noteBuffer = [];
    }
    if (this.buffer.length === 0) return;
    const repoDir = await this.repoDir();
    // Dirty from the FIRST op, not the last: a mid-apply failure must leave
    // the handle marked so the safe-boot rollback sweeps its partial writes.
    this.dirty = true;
    const ops = this.buffer;
    this.buffer = [];
    for (const op of ops) {
      if (op.kind === 'write') {
        this.applied.add(op.path);
        const abs = await containedPath(repoDir, op.path);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, op.content);
      } else if (op.kind === 'move') {
        // The SOURCE is recorded unconditionally: finalize must stage its
        // disappearance. (Harmless to the rollback — a tracked source is
        // restored by the reset, and `clean` never touches tracked paths.)
        this.applied.add(op.from);
        const from = await containedPath(repoDir, op.from);
        const to = await containedPath(repoDir, op.to);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
        // Recorded AFTER the rename, unlike a write's pre-record: rename
        // cannot leave a partial destination (it either happened or errored
        // with the target untouched), and pre-recording would let the
        // rollback delete a pre-existing ignored file at an untouched target.
        this.applied.add(op.to);
      } else {
        // Recorded unconditionally, like a move's source: finalize must stage
        // the deletion of a removed tracked file.
        this.applied.add(op.path);
        const abs = await containedPath(repoDir, op.path);
        await fs.rm(abs, { force: true });
      }
    }
  }

  /** Ops declared by the current step and not yet applied — log material. */
  pendingOpCount(): number {
    return this.buffer.length;
  }

  /**
   * Every path the applied ops touched — sources and targets. Finalize stages
   * exactly this set (force-added past any branch `.gitignore`); the safe-boot
   * rollback scopes its `clean` to it.
   */
  appliedPaths(): readonly string[] {
    return [...this.applied];
  }

  /**
   * Discard everything the phase did (safe boot's abandonment). Keyed on
   * `dirty`, which is set BEFORE the first op applies, so a mid-apply failure
   * is covered — while a clone a step only read is never swept.
   *
   * `reset --hard` targets the PRE-PHASE sha recorded at clone time, not
   * HEAD: a finalize commit that was created but failed to push must roll
   * back too, or it survives as a stranded local commit no later boot would
   * ever push. The reset restores everything tracked; the SCOPED
   * `clean -fdx -- <op paths>` then removes files the ops created (including
   * a partial write whose path a branch `.gitignore` happens to match). No
   * global `clean`: it would delete pre-existing untracked files in a
   * surviving working clone that the phase never touched.
   */
  async resetUncommitted(): Promise<void> {
    if (!this.dirty) return;
    const repoDir = await this.repoDir();
    await git(this.gitRunner, repoDir, ['reset', '--hard', this.prePhaseSha ?? 'HEAD']).catch(() => {});
    if (this.applied.size > 0) {
      // `:(literal)` — these are file paths, not pathspecs: a name that
      // happens to contain glob or magic characters must match itself only,
      // never broaden the cleanup.
      await git(this.gitRunner, repoDir, [
        'clean',
        '-fdx',
        '--',
        ...[...this.applied].map((rel) => `:(literal)${rel}`),
      ]).catch(() => {});
    }
  }

  commitSubject(): string {
    return this.notes[0] ?? "Bring the knowledge base up to this build's expectations";
  }
  commitMessage(): string {
    if (this.notes.length <= 1) return this.commitSubject();
    return `${this.commitSubject()}\n\n${this.notes.slice(1).map((n) => `- ${n}`).join('\n')}`;
  }
}

function lazyOnce<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= fn());
}

/**
 * Resolve a repo-relative op path and refuse everything the write layer
 * refuses: absolute paths, `..` escapes, and any SYMLINK among the existing
 * components (a link is a second path to other content — the two can
 * disagree about what a write actually touched).
 */
async function containedPath(repoDir: string, rel: string): Promise<string> {
  if (!rel || path.isAbsolute(rel)) {
    throw new Error(`op path "${rel}" must be a non-empty repo-relative path`);
  }
  const abs = path.resolve(repoDir, rel);
  const rootRel = path.relative(repoDir, abs);
  if (rootRel.startsWith('..') || path.isAbsolute(rootRel)) {
    throw new Error(`op path "${rel}" escapes the repository`);
  }
  // Walk the EXISTING ancestry; every present component must be a real
  // file/dir. (`.git` is off-limits outright.)
  if (rootRel === '.git' || rootRel.startsWith(`.git${path.sep}`)) {
    throw new Error(`op path "${rel}" targets .git`);
  }
  let probe = abs;
  while (probe !== repoDir) {
    const stat = await fs.lstat(probe).catch(() => null);
    if (stat?.isSymbolicLink()) {
      throw new Error(`op path "${rel}" traverses a symlink at "${path.relative(repoDir, probe)}"`);
    }
    probe = path.dirname(probe);
  }
  return abs;
}
