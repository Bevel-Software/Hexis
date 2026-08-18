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
      fill; the runner handles init/commit/push around it. */
  buildSeedTree: (dir: string) => Promise<void>;
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
    const safeBoot = process.env.KB_SAFE_BOOT === '1';
    if (safeBoot) {
      console.warn(
        '[kb-startup] KB_SAFE_BOOT=1 — failures will abandon maintenance instead of stopping the boot. ' +
          'Remove the variable once the rescue is done.',
      );
    }

    const handles = new Map<string, BranchHandle>();
    const heads = await this.ensureRemote();
    const ctx = this.buildContext(heads, handles);

    try {
      for (const step of this.opts.steps) {
        const result = await step.run(ctx).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(redactSecret(`KB startup step "${step.name}" failed: ${msg}`));
        });
        if (result.outcome === 'stopBoot') {
          throw new Error(`KB startup step "${step.name}" stopped the boot: ${result.message}`);
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
    } catch (err) {
      if (!safeBoot) throw err;
      console.error(
        '[kb-startup] SAFE BOOT: abandoning the phase after a failure — the KB is UNMAINTAINED this run.',
        redactSecret(err instanceof Error ? err.message : String(err)),
      );
      for (const h of handles.values()) await h.resetUncommitted().catch(() => {});
      return;
    }

    for (const h of handles.values()) {
      await this.finalize(h);
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
        await this.opts.buildSeedTree(dir);
        await git(dir, user, ['add', '-A']);
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
    const status = (await git(repoDir, user, ['status', '--porcelain'])).trim();
    if (status === '') return; // ops converged to no byte changes — nothing to commit
    await git(repoDir, user, ['commit', '-m', h.commitMessage()]);
    try {
      await git(repoDir, user, ['push', 'origin', `HEAD:refs/heads/${h.name}`]);
      console.log(`[kb-startup] ${h.name}: ${h.commitSubject()}`);
    } catch (err) {
      // The carve-out: a concurrent replica won the push race. Its pass made
      // the same idempotent changes; roll back and let the next boot converge.
      console.warn(
        `[kb-startup] ${h.name}: push rejected (concurrent replica?) — rolling back local commit.`,
        redactSecret(err instanceof Error ? err.message : String(err)),
      );
      await git(repoDir, user, ['reset', '--hard', `origin/${h.name}`]).catch(() => {});
    }
  }
}

type BufferedOp =
  | { kind: 'write'; path: string; content: string | Uint8Array }
  | { kind: 'move'; from: string; to: string }
  | { kind: 'remove'; path: string };

/**
 * The {@link KbBranch} implementation: a lazy clone plus an op buffer. Ops
 * accumulate while a step runs; the RUNNER applies them (`applyBuffer`) on
 * `ok`/`partial` and drops them (`discardBuffer`) on `skipped`. Applied ops
 * mark the handle dirty; notes accumulate across steps into one commit.
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
  private notes: string[] = [];
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
    this.notes.push(line);
  }

  discardBuffer(): void {
    this.buffer = [];
  }

  /** Apply buffered ops in declaration order, each path contained to the clone. */
  async applyBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;
    const repoDir = await this.repoDir();
    const ops = this.buffer;
    this.buffer = [];
    for (const op of ops) {
      if (op.kind === 'write') {
        const abs = await containedPath(repoDir, op.path);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, op.content);
      } else if (op.kind === 'move') {
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

  /** Discard everything uncommitted (safe boot's abandonment). */
  async resetUncommitted(): Promise<void> {
    if (!this.dirty) return;
    const repoDir = await this.repoDir();
    await git(repoDir, 'x-access-token', ['reset', '--hard', 'HEAD']).catch(() => {});
    await git(repoDir, 'x-access-token', ['clean', '-fd']).catch(() => {});
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
