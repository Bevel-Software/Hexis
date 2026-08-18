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

    const handles = new Map<string, BranchHandle>();
    // ONE safe-boot boundary around the whole phase — remote preparation, the
    // step loop, AND the finalize commits. Rescue mode must be able to reset
    // and boot whichever of them fails; a boundary around the step loop alone
    // would let an ensureRemote or finalize failure stop the very boot
    // KB_SAFE_BOOT exists to allow.
    try {
      const heads = await this.ensureRemote();
      const ctx = this.buildContext(heads, handles);

      for (const step of this.opts.steps) {
        const result = await step.run(ctx).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(redactSecret(`KB startup step "${step.name}" failed: ${msg}`));
        });
        if (result.outcome === 'stopBoot') {
          // Redacted like every other exit: the message travels beyond logs
          // (the setup status endpoint surfaces it to admins).
          throw new Error(
            redactSecret(`KB startup step "${step.name}" stopped the boot: ${result.message}`),
          );
        }
        if (result.outcome === 'skipped') {
          console.warn(`[kb-startup] ${step.name}: skipped — ${result.reason}`);
          for (const h of handles.values()) h.discardBuffer();
          continue;
        }
        if (result.outcome === 'partial') {
          console.warn(`[kb-startup] ${step.name}: partial — ${result.reason}`);
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
      // clone a step merely read must NOT be swept: `clean -fd` would delete
      // pre-existing untracked files in a surviving working clone that no op
      // ever touched.
      for (const h of handles.values()) await h.resetUncommitted().catch(() => {});
      return;
    }
    console.log('[kb-startup] phase complete.');
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
      await withTempDir(async (dir) => {
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
        await git(dir, user, ['push', '-u', 'origin', ...protectedBranches]);
      });
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
    await git(repoDir, user, ['add', '-A']);
    // A branch's own `.gitignore` can swallow a managed write: `add -A` skips
    // ignored paths, so a declared op could land on disk and still read as
    // "converged, nothing to commit" below. Force-add the paths the applied
    // ops produced (writes + move destinations); paths a later op removed or
    // relocated again are filtered out, since an unmatched pathspec is an
    // error (their disappearance is `add -A`'s to stage).
    const produced: string[] = [];
    for (const rel of h.appliedPaths()) {
      const onDisk = await fs.access(path.join(repoDir, rel)).then(() => true, () => false);
      if (onDisk) produced.push(rel);
    }
    if (produced.length > 0) await git(repoDir, user, ['add', '-f', '--', ...produced]);
    const status = (await git(repoDir, user, ['status', '--porcelain'])).trim();
    if (status === '') return; // ops converged to no byte changes — nothing to commit
    // The commit this phase is about to add, remembered so the rollback below
    // can undo exactly it — and ONLY it. Resetting to origin/<name> instead
    // would also nuke a pre-existing committed-but-unpushed (AHEAD) commit
    // that ensureClone deliberately preserved.
    const preCommit = (await git(repoDir, user, ['rev-parse', 'HEAD'])).trim();
    await git(repoDir, user, ['commit', '-m', h.commitMessage()]);
    try {
      await git(repoDir, user, ['push', 'origin', `HEAD:refs/heads/${h.name}`]);
      console.log(`[kb-startup] ${h.name}: ${h.commitSubject()}`);
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
    this.clone = lazyOnce(cloneOnce);
  }

  private readonly clone: () => Promise<string>;
  private buffer: BufferedOp[] = [];
  /** The CURRENT step's notes — kept or discarded with its ops. */
  private noteBuffer: string[] = [];
  /** Notes of applied steps, in order — the commit message's material. */
  private notes: string[] = [];
  /**
   * Repo-relative target paths of ops an apply ATTEMPTED (writes + move
   * destinations), recorded before each op executes so even the op that
   * failed mid-apply leaves its path here for the rollback to clean.
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
        this.applied.add(op.to);
        const from = await containedPath(repoDir, op.from);
        const to = await containedPath(repoDir, op.to);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
      } else {
        const abs = await containedPath(repoDir, op.path);
        await fs.rm(abs, { force: true });
      }
    }
    this.dirty = true;
  }

  /** What the applied ops put on disk — finalize force-adds these past any branch `.gitignore`. */
  appliedPaths(): readonly string[] {
    return [...this.applied];
  }

  /**
   * Discard everything uncommitted (safe boot's abandonment). Keyed on
   * `dirty`, which is set BEFORE the first op applies, so a mid-apply failure
   * is covered — while a clone a step only read is never swept (`clean -fd`
   * on it would delete pre-existing untracked files no op ever touched). The
   * extra `clean -fdx -- <op targets>` catches a partial write whose path a
   * branch `.gitignore` happens to match, which plain `-fd` preserves.
   */
  async resetUncommitted(): Promise<void> {
    if (!this.dirty) return;
    const repoDir = await this.repoDir();
    await git(repoDir, 'x-access-token', ['reset', '--hard', 'HEAD']).catch(() => {});
    await git(repoDir, 'x-access-token', ['clean', '-fd']).catch(() => {});
    if (this.applied.size > 0) {
      await git(repoDir, 'x-access-token', ['clean', '-fdx', '--', ...this.applied]).catch(() => {});
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
