import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceMutex } from '../kb-fs/mutex.js';
import type { VirtualTree } from '../plugins/compile/compile-marketplace.js';

const execFileAsync = promisify(execFile);

/** What the repo service asks the compiler for — the one seam it has. */
export interface MarketplaceCompiler {
  sourceCommit(): Promise<string>;
  compileFor(audience: { userEmail: string }): Promise<VirtualTree & { sourceCommit: string }>;
}

export interface EnsureResult {
  /** The git namespace the caller's tree lives in. */
  namespace: string;
  /** True when a new commit was written this call. */
  compiled: boolean;
  sourceCommit: string;
}

/**
 * ONE bare repository, ONE git namespace per caller.
 *
 * Every person's compiled marketplace is a branch in its own namespace
 * (`refs/namespaces/<ns>/refs/heads/main`), which is exactly what git
 * namespaces exist for (gitnamespaces(7)): `git http-backend` run with
 * `GIT_NAMESPACE=<ns>` advertises only that namespace's refs, so a clone sees
 * a repository whose `main` is their tree and nothing else — while every
 * identical skill across callers is one blob in one object store.
 *
 * Freshness is LAZY and keyed on the knowledge base's default-branch commit:
 * every input to a compile (skills, manifests, access rules, roles, groups)
 * lives in that repository, so "same source commit" means "same answer".
 * The last compiled source per namespace sits in a sidecar file rather than
 * a commit trailer, so an unchanged tree costs no commit and no re-check.
 *
 * Each recompile appends a commit whose parent is the namespace's current
 * head, so a client's `git pull` is always a fast-forward — including when
 * access was withdrawn and files vanish. Writes go through git plumbing
 * against a temporary index: no working tree of the bare repo, no checkout.
 *
 * Read-only by construction: `http.receivepack` is pinned off (http-backend
 * would otherwise enable pushes for an authenticated REMOTE_USER), and the
 * route refuses the receive-pack service before git ever sees it.
 */
export class MarketplaceRepoService {
  private readonly locks = new WorkspaceMutex();
  private initialised: Promise<void> | null = null;

  constructor(
    /** Absolute path of the bare repository (created on first use). */
    readonly repoDir: string,
    private readonly compiler: MarketplaceCompiler,
    private readonly committer: { name: string; email: string } = {
      name: 'Hexis',
      email: 'hexis@localhost',
    },
  ) {}

  /** The directory `GIT_PROJECT_ROOT` points at, and the repo's name under it. */
  get projectRoot(): string {
    return path.dirname(this.repoDir);
  }
  get repoName(): string {
    return path.basename(this.repoDir);
  }

  /** The namespace for a user id — one path segment, stable, opaque. */
  static namespaceFor(userId: string): string {
    return `u-${userId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)}`;
  }

  async ensureRepo(): Promise<void> {
    this.initialised ??= (async () => {
      await fs.mkdir(this.projectRoot, { recursive: true });
      const isRepo = await fs
        .access(path.join(this.repoDir, 'HEAD'))
        .then(() => true, () => false);
      if (!isRepo) await this.git(['init', '--bare', '--quiet', this.repoDir]);
      await this.git(['-C', this.repoDir, 'config', 'http.receivepack', 'false']);
      await this.git(['-C', this.repoDir, 'config', 'http.uploadpack', 'true']);
      await fs.mkdir(this.sidecarDir(), { recursive: true });
    })();
    await this.initialised;
  }

  /**
   * Bring the caller's namespace up to the knowledge base's current commit,
   * compiling only when it moved. Serialised per namespace: two fetches
   * arriving together compile once.
   */
  async ensureCompiled(user: { id: string; email: string }): Promise<EnsureResult> {
    await this.ensureRepo();
    const namespace = MarketplaceRepoService.namespaceFor(user.id);
    return this.locks.run(`ns:${namespace}`, async () => {
      const current = await this.compiler.sourceCommit();
      const last = await this.readSidecar(namespace);
      const head = await this.headOf(namespace);
      if (last === current && head !== null) return { namespace, compiled: false, sourceCommit: current };

      const tree = await this.compiler.compileFor({ userEmail: user.email });
      const sha = await this.commitTree(namespace, tree, head);
      await this.writeSidecar(namespace, tree.sourceCommit);
      return { namespace, compiled: sha !== head, sourceCommit: tree.sourceCommit };
    });
  }

  // --- internal --------------------------------------------------------------

  private refOf(namespace: string): string {
    return `refs/namespaces/${namespace}/refs/heads/main`;
  }

  private async headOf(namespace: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(['-C', this.repoDir, 'rev-parse', '--verify', '--quiet', this.refOf(namespace)]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Write `tree` as a commit on the namespace's branch. Materialises the
   * virtual tree into a scratch directory, stages it into a throwaway index
   * against the bare object store, and commits — no working tree involved.
   * When the tree hash equals the head's, nothing is committed.
   */
  private async commitTree(
    namespace: string,
    tree: VirtualTree & { sourceCommit: string },
    parent: string | null,
  ): Promise<string> {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'hexis-marketplace-'));
    try {
      for (const [rel, bytes] of tree.files) {
        // The compiler sanitises every segment it invents, but the tree is
        // built from repository content, so the sink checks containment
        // itself: nothing is written outside the scratch directory.
        const abs = path.resolve(scratch, rel);
        if (!abs.startsWith(scratch + path.sep)) {
          throw new Error(`refusing to materialise "${rel}": escapes the scratch tree`);
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, bytes);
      }
      const index = path.join(scratch, '.hexis-index');
      const env = { ...process.env, GIT_INDEX_FILE: index, GIT_DIR: this.repoDir, GIT_WORK_TREE: scratch };
      await this.git(['add', '-A', '--', '.'], { cwd: scratch, env });
      const treeSha = (await this.git(['write-tree'], { env })).stdout.trim();
      if (parent) {
        const parentTree = (await this.git(['-C', this.repoDir, 'rev-parse', `${parent}^{tree}`])).stdout.trim();
        if (parentTree === treeSha) return parent;
      }
      const message = `Compile marketplace from ${tree.sourceCommit}\n\nHexis-Source-Commit: ${tree.sourceCommit}\n`;
      const commitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: this.committer.name,
        GIT_AUTHOR_EMAIL: this.committer.email,
        GIT_COMMITTER_NAME: this.committer.name,
        GIT_COMMITTER_EMAIL: this.committer.email,
      };
      const args = ['-C', this.repoDir, 'commit-tree', treeSha, '-m', message, ...(parent ? ['-p', parent] : [])];
      const sha = (await this.git(args, { env: commitEnv })).stdout.trim();
      await this.git(['-C', this.repoDir, 'update-ref', this.refOf(namespace), sha, ...(parent ? [parent] : [])]);
      await this.git(['-C', this.repoDir, 'symbolic-ref', `refs/namespaces/${namespace}/HEAD`, this.refOf(namespace)]);
      return sha;
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }

  private sidecarDir(): string {
    return path.join(this.repoDir, 'hexis-namespaces');
  }

  private async readSidecar(namespace: string): Promise<string | null> {
    try {
      return (await fs.readFile(path.join(this.sidecarDir(), `${namespace}.json`), 'utf-8')).trim() || null;
    } catch {
      return null;
    }
  }

  private async writeSidecar(namespace: string, sourceCommit: string): Promise<void> {
    await fs.writeFile(path.join(this.sidecarDir(), `${namespace}.json`), sourceCommit);
  }

  private git(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    return execFileAsync('git', args, { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
  }
}
