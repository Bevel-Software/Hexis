import fs from 'node:fs/promises';
import path from 'node:path';
import { isBranchModelConfigured } from '@bevel-software/platform-shared';
import { workspaceIdForBranch } from '../workspace.service.js';
import type { KbBranch, OnServerStart, ServerStartContext } from './on-server-start.js';
import { git, lsRemoteHeads, redactSecret, stampIdentity, withTempDir } from './kb-git.js';

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
  kbRepoUrl: () => string;
  gitUsername: () => string;
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

export class KbStartupRunner {
  constructor(private readonly opts: KbStartupRunnerOptions) {}

  /**
   * Run the whole phase. Throws to stop the boot; returns normally when the
   * KB is fully maintained (or safe boot abandoned the phase, loudly).
   */
  async runAll(): Promise<void> {
    if (!isBranchModelConfigured()) {
      console.log('[kb-startup] branch model not configured yet — phase skipped until setup completes.');
      return;
    }
    // A branch model without a repository URL is a PARTIALLY set-up deployment
    // (the two can arrive on different saves, and a restart can land between
    // them). There is nothing to maintain yet, and running anyway would
    // `ls-remote ''` — a boot that fails forever while the setup screen it
    // needs stays unreachable. The setup-completion invocation catches up the
    // moment the URL exists.
    if (this.opts.kbRepoUrl().trim() === '') {
      console.log('[kb-startup] KB repository URL not configured yet — phase skipped until setup completes.');
      return;
    }
    const safeBoot = process.env.KB_SAFE_BOOT === '1';
    if (safeBoot) {
      console.warn(
        '[kb-startup] KB_SAFE_BOOT=1 — failures will abandon maintenance instead of stopping the boot. ' +
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
          throw new Error(redactSecret(`KB startup step "${step.name}" failed: ${msg}`));
        });
        const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
        if (result.outcome === 'stopBoot') {
          // Redacted like every other exit: the message travels beyond logs
          // (the setup status endpoint surfaces it to admins).
          throw new Error(
            redactSecret(`KB startup step "${step.name}" stopped the boot: ${result.message}`),
          );
        }
        if (result.outcome === 'skipped') {
          console.warn(`[kb-startup] ${step.name}: skipped — ${result.reason} (${took})`);
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
          console.warn(`[kb-startup] ${step.name}: partial — ${result.reason} (${scope}, ${took})`);
        } else {
          // One line per step even when nothing happened: a silent phase and a
          // step that never ran look identical from the boot log otherwise.
          console.log(`[kb-startup] ${step.name}: ok — ${scope} (${took})`);
        }
        for (const h of handles.values()) await h.applyBuffer();
      }

      for (const h of handles.values()) {
        await this.finalize(h);
      }
    } catch (err) {
      if (!safeBoot) throw err;
      console.error(
        '[kb-startup] SAFE BOOT: abandoning the phase after a failure — the KB is UNMAINTAINED this run.',
        redactSecret(err instanceof Error ? err.message : String(err)),
      );
      // Reset only DIRTY handles — ones an apply at least began on (the mark
      // is set before the first op, so a mid-apply failure is covered). A
      // clone a step merely read must NOT be swept: sweeping it would disturb
      // pre-existing state in a surviving working clone that no op ever
      // touched. Each reset targets the handle's recorded pre-phase sha, so
      // even a created-but-unpushed finalize commit is rolled back.
      for (const h of handles.values()) await h.resetUncommitted().catch(() => {});
      return;
    }
    console.log(`[kb-startup] phase complete (${((Date.now() - phaseStart) / 1000).toFixed(1)}s).`);
  }

  /**
   * Remote preparation — runner machinery, not a step, because every remote
   * failure mode here is the runner's to own: an EMPTY remote gets the full
   * seed commit pushed to every protected branch; missing protected refs are
   * created from the best base. Returns the remote's head names (post-seed).
   */
  private async ensureRemote(): Promise<Set<string>> {
    const url = this.opts.kbRepoUrl();
    const user = this.opts.gitUsername();
    const heads = await lsRemoteHeads(url, user);
    const protectedBranches = this.opts.protectedBranches();
    const defaultBranch = this.opts.defaultBranch();

    if (heads.size === 0) {
      if (this.opts.seedAdminEmails.length === 0) {
        throw new Error(
          'KB remote is empty and cannot be seeded: no initial Admin was supplied (ADMIN_EMAIL).',
        );
      }
      const seededByOther = await withTempDir(async (dir) => {
        await git(dir, user, ['init', '-b', defaultBranch]);
        await stampIdentity(dir, user);
        const generated = await this.opts.buildSeedTree(dir);
        await git(dir, user, ['add', '-A']);
        // The template may ship a `.gitignore` whose rules happen to match a
        // GENERATED seed file (roles.yaml, a reserved root's .gitkeep) —
        // `add -A` would silently drop it from the seed commit. Force-add
        // exactly what the builder generated; `-f` on an already-staged path
        // is a no-op.
        if (generated.length > 0) await git(dir, user, ['add', '-f', '--', ...generated]);
        await git(dir, user, ['commit', '-m', 'Seed knowledge base from Bevel template']);
        for (const b of protectedBranches) {
          if (b !== defaultBranch) await git(dir, user, ['branch', b]);
        }
        await git(dir, user, ['remote', 'add', 'origin', url]);
        try {
          await git(dir, user, ['push', '-u', 'origin', ...protectedBranches]);
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
          const reread = await lsRemoteHeads(url, user);
          if (protectedBranches.every((b) => reread.has(b))) return reread;
          throw err;
        }
      });
      if (seededByOther) {
        console.log(
          '[kb-startup] seed push rejected — another replica seeded the remote first; continuing with its branches.',
        );
        return seededByOther;
      }
      console.log(`[kb-startup] seeded empty KB remote with branches: ${protectedBranches.join(', ')}`);
      return new Set(protectedBranches);
    }

    const base = heads.has(defaultBranch)
      ? defaultBranch
      : (protectedBranches.find((b) => heads.has(b)) ?? [...heads].sort()[0]!);
    for (const b of protectedBranches) {
      if (heads.has(b)) continue;
      await withTempDir(async (dir) => {
        await git(dir, user, ['clone', '--depth', '1', '-b', base, url, 'seed']);
        await git(path.join(dir, 'seed'), user, ['push', 'origin', `HEAD:refs/heads/${b}`]);
      });
      heads.add(b);
      console.log(`[kb-startup] created missing protected branch "${b}" from "${base}"`);
    }
    return heads;
  }

  private buildContext(heads: Set<string>, handles: Map<string, BranchHandle>): ServerStartContext {
    const protectedSet = new Set(this.opts.protectedBranches());
    const handleFor = (branch: string): BranchHandle => {
      let h = handles.get(branch);
      if (!h) {
        h = new BranchHandle(branch, protectedSet.has(branch), () => this.ensureClone(branch));
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
    const user = this.opts.gitUsername();
    const workspaceDir = path.join(this.opts.workspacesRoot, workspaceIdForBranch(branch));
    const repoDir = path.join(workspaceDir, this.opts.kbDirName);
    const hasGit = await fs.access(path.join(repoDir, '.git')).then(() => true, () => false);
    if (!hasGit) {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.rm(repoDir, { recursive: true, force: true });
      await git(workspaceDir, user, ['clone', '-b', branch, this.opts.kbRepoUrl(), repoDir]);
      await git(repoDir, user, ['config', 'core.longpaths', 'true']);
      await stampIdentity(repoDir, user);
      return repoDir;
    }
    await git(repoDir, user, ['fetch', 'origin', branch]);
    const local = (await git(repoDir, user, ['rev-parse', 'HEAD'])).trim();
    const remote = (await git(repoDir, user, ['rev-parse', `origin/${branch}`])).trim();
    if (local !== remote) {
      const mergeBase = (await git(repoDir, user, ['merge-base', 'HEAD', `origin/${branch}`])).trim();
      if (mergeBase === local) {
        await git(repoDir, user, ['reset', '--hard', `origin/${branch}`]);
      }
      // Ahead or diverged: committed-but-unpushed work lives here; not ours to discard.
    }
    return repoDir;
  }

  /** One commit per dirty branch; push; the replica carve-out on rejection. */
  private async finalize(h: BranchHandle): Promise<void> {
    if (!h.dirty) return;
    const repoDir = await h.repoDir();
    const user = this.opts.gitUsername();
    await stampIdentity(repoDir, user);
    // Drop any PRE-EXISTING index state first (a crashed tool may have left
    // edits staged): `git commit` publishes the whole index, and the phase
    // must commit exactly its own staged set. The edits stay in the working
    // tree, unstaged and unpublished — preserved, not adopted.
    await git(repoDir, user, ['reset', '-q']);
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
        const known = (await git(repoDir, user, ['ls-files', '--', `:(literal)${rel}`])).trim();
        if (known === '') continue;
      }
      touched.push(rel);
    }
    // `:(literal)` — these are file paths, not pathspecs; chunked so a large
    // migration cannot overflow the platform's argv limit.
    for (let i = 0; i < touched.length; i += 100) {
      await git(repoDir, user, [
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
    const nothingStaged = await git(repoDir, user, ['diff', '--cached', '--quiet']).then(
      () => true,
      () => false,
    );
    if (nothingStaged) return;
    // The commit this phase is about to add, remembered so the rollback below
    // can undo exactly it — and ONLY it. Resetting to origin/<name> instead
    // would also nuke a pre-existing committed-but-unpushed (AHEAD) commit
    // that ensureClone deliberately preserved.
    const preCommit = (await git(repoDir, user, ['rev-parse', 'HEAD'])).trim();
    await git(repoDir, user, ['commit', '-m', h.commitMessage()]);
    try {
      await git(repoDir, user, ['push', 'origin', `HEAD:refs/heads/${h.name}`]);
      console.log(`[kb-startup] ${h.name}: ${h.commitSubject()}`);
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
      console.warn(
        `[kb-startup] ${h.name}: push rejected (concurrent replica?) — rolling back local commit.`,
        redactSecret(msg),
      );
      await git(repoDir, user, ['reset', '--hard', preCommit]).catch(() => {});
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
      this.prePhaseSha = (await git(dir, 'x-access-token', ['rev-parse', 'HEAD'])).trim();
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
    await git(repoDir, 'x-access-token', ['reset', '--hard', this.prePhaseSha ?? 'HEAD']).catch(() => {});
    if (this.applied.size > 0) {
      // `:(literal)` — these are file paths, not pathspecs: a name that
      // happens to contain glob or magic characters must match itself only,
      // never broaden the cleanup.
      await git(repoDir, 'x-access-token', [
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
