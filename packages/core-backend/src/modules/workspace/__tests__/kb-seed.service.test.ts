import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { KbSeedService } from '../kb-seed.service.js';
import { defaultKbTemplateDir } from '../../../assets.js';

const execFileAsync = promisify(execFile);

/** The real seed template shipped inside this package (see assets.ts). */
const TEMPLATE_DIR = defaultKbTemplateDir();

const PROTECTED = ['current-company-state', 'target-company-state'];
const DEFAULT_BRANCH = 'current-company-state';
const ADMINS = ['alice@example.com', 'bob@example.com'];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
  return stdout.toString();
}

function makeSeeder(
  upstream: string,
  admins: readonly string[] = ADMINS,
  extraDirs: readonly string[] = [],
): KbSeedService {
  return new KbSeedService(
    upstream,
    TEMPLATE_DIR,
    PROTECTED,
    DEFAULT_BRANCH,
    admins,
    'x-access-token',
    extraDirs,
  );
}

/** Clone a branch of the upstream into a fresh checkout for inspection. */
async function checkout(root: string, upstream: string, branch: string): Promise<string> {
  const dir = path.join(root, `checkout-${branch}-${Math.random().toString(36).slice(2)}`);
  await git(root, ['clone', '-b', branch, upstream, dir]);
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function headCommitCount(root: string, upstream: string, branch: string): Promise<number> {
  const dir = await checkout(root, upstream, branch);
  const out = await git(dir, ['rev-list', '--count', 'HEAD']);
  return Number(out.trim());
}

describe('KbSeedService', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-seed-test-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /** A bare, branch-less "empty" remote. */
  async function emptyUpstream(): Promise<string> {
    const upstream = path.join(root, 'upstream.git');
    await git(root, ['init', '--bare', upstream]);
    return upstream;
  }

  /** A bare remote pre-seeded on `branches`, each with `files` written at the root. */
  async function seededUpstream(
    branches: string[],
    files: Record<string, string>,
  ): Promise<string> {
    const upstream = path.join(root, 'upstream.git');
    await git(root, ['init', '--bare', upstream]);
    const seed = path.join(root, '.seed');
    await fs.mkdir(seed);
    await git(seed, ['init', '-b', branches[0]]);
    await git(seed, ['remote', 'add', 'origin', upstream]);
    for (const [name, content] of Object.entries(files)) {
      const abs = path.join(seed, name);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
    }
    await git(seed, ['add', '-A']);
    await git(seed, ['commit', '-m', 'pre-seed']);
    for (const b of branches.slice(1)) await git(seed, ['branch', b]);
    await git(seed, ['push', 'origin', ...branches]);
    return upstream;
  }

  describe('empty remote → full seed', () => {
    it('seeds every protected branch with base scaffolding + generated roles.yaml', async () => {
      const upstream = await emptyUpstream();
      await makeSeeder(upstream).ensureRemoteSeeded();

      for (const branch of PROTECTED) {
        const dir = await checkout(root, upstream, branch);
        expect(await exists(path.join(dir, 'access.md'))).toBe(true);
        expect(await exists(path.join(dir, 'AGENTS.md'))).toBe(true);
        expect(await exists(path.join(dir, '.bevelignore'))).toBe(true);
        expect(await exists(path.join(dir, '.gitignore'))).toBe(true);
        // Core's two roots are seeded (kept present via their .gitkeep).
        expect(await exists(path.join(dir, 'KnowledgeBase/.gitkeep'))).toBe(true);
        expect(await exists(path.join(dir, 'Groups/.gitkeep'))).toBe(true);
        // …and only those two. `Data/`, `Agents/` and `Pipelines/` scaffold an
        // agentic execution layer this platform does not have, so seeding them
        // would hand every operator three empty folders nothing can fill.
        for (const enterpriseOnly of ['Data', 'Agents', 'Pipelines']) {
          expect(await exists(path.join(dir, enterpriseOnly))).toBe(false);
        }

        const roles = await fs.readFile(path.join(dir, 'roles.yaml'), 'utf8');
        for (const email of ADMINS) expect(roles).toContain(email);
        // The template's illustrative placeholder must NOT leak into the seed.
        expect(roles).not.toContain('admin@example.com');
      }
    });

    // Unreachable through the app — `ADMIN_EMAIL` is required at boot, so the
    // list always has exactly one entry. Kept as a guard on the seeder's own
    // contract: a KB seeded with no Admin cannot resolve access at all, and
    // silently writing an Admin-less roles.yaml would be worse than refusing.
    it('refuses to seed an empty remote with no initial Admin', async () => {
      const upstream = await emptyUpstream();
      await expect(makeSeeder(upstream, []).ensureRemoteSeeded()).rejects.toThrow(
        /no initial Admin/,
      );
    });
  });

  describe('existing remote → conservative top-up', () => {
    it('creates a missing protected branch off an existing one', async () => {
      // Only current-company-state exists; target-company-state is missing.
      const upstream = await seededUpstream([DEFAULT_BRANCH], {
        'roles.yaml': 'roles:\n  Admin:\n    - keep@example.com\n',
        'access.md': 'existing',
        'AGENTS.md': 'existing',
        '.bevelignore': 'x',
        '.gitignore': 'x',
        'KnowledgeBase/Real/Knowledge/.gitkeep': '',
        'Groups/.gitkeep': '',
      });

      await makeSeeder(upstream).ensureRemoteSeeded();

      const heads = await git(root, ['ls-remote', '--heads', upstream]);
      expect(heads).toContain('refs/heads/target-company-state');
    });

    it('topUpWorkspace adds only missing scaffolding and never overwrites existing files', async () => {
      const upstream = await seededUpstream(PROTECTED, {
        // roles.yaml + access.md already exist with custom content — must survive.
        'roles.yaml': 'roles:\n  Admin:\n    - keep@example.com\n',
        'access.md': 'CUSTOM ACCESS RULES',
        // AGENTS.md / .bevelignore / .gitignore are absent → should be added.
        'KnowledgeBase/Real/Knowledge/.gitkeep': '',
        'Groups/.gitkeep': '',
      });

      // Simulate the app loading the branch: a fresh clone, then top-up on it.
      const repoDir = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(repoDir, DEFAULT_BRANCH);

      // Verify the pushed remote state via an independent clone.
      const dir = await checkout(root, upstream, DEFAULT_BRANCH);
      // Existing files preserved verbatim.
      expect(await fs.readFile(path.join(dir, 'access.md'), 'utf8')).toBe('CUSTOM ACCESS RULES');
      expect(await fs.readFile(path.join(dir, 'roles.yaml'), 'utf8')).toContain('keep@example.com');
      // Missing scaffolding added.
      expect(await exists(path.join(dir, 'AGENTS.md'))).toBe(true);
      expect(await exists(path.join(dir, '.bevelignore'))).toBe(true);
      // Sample content is NOT restored — the real KnowledgeBase already had content,
      // so no placeholder .gitkeep is dropped into it, and no ExampleOntology appears.
      expect(await exists(path.join(dir, 'KnowledgeBase/.gitkeep'))).toBe(false);
      expect(await exists(path.join(dir, 'KnowledgeBase/ExampleOntology'))).toBe(false);
    });

    it('topUpWorkspace is idempotent — a second load makes no new commit', async () => {
      const upstream = await seededUpstream(PROTECTED, {
        'roles.yaml': 'roles:\n  Admin:\n    - keep@example.com\n',
        'KnowledgeBase/Real/Knowledge/.gitkeep': '',
        'Groups/.gitkeep': '',
      });

      const first = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(first, DEFAULT_BRANCH);
      const after1 = await headCommitCount(root, upstream, DEFAULT_BRANCH);

      // A later reload: fresh clone reflects the pushed scaffolding, so top-up
      // finds nothing missing and makes no new commit.
      const second = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(second, DEFAULT_BRANCH);
      const after2 = await headCommitCount(root, upstream, DEFAULT_BRANCH);

      expect(after2).toBe(after1);
    });

    it('topUpWorkspace fills scaffolding on a non-protected feature branch too', async () => {
      const upstream = await seededUpstream(PROTECTED, {
        'roles.yaml': 'roles:\n  Admin:\n    - keep@example.com\n',
        'KnowledgeBase/Real/Knowledge/.gitkeep': '',
        'Groups/.gitkeep': '',
      });
      // Branch a feature off the default and load it.
      const seed = await checkout(root, upstream, DEFAULT_BRANCH);
      await git(seed, ['checkout', '-b', 'alice/feature']);
      await git(seed, ['push', 'origin', 'alice/feature']);

      const repoDir = await checkout(root, upstream, 'alice/feature');
      await makeSeeder(upstream).topUpWorkspace(repoDir, 'alice/feature');

      const dir = await checkout(root, upstream, 'alice/feature');
      expect(await exists(path.join(dir, 'AGENTS.md'))).toBe(true);
      expect(await exists(path.join(dir, 'access.md'))).toBe(true);
    });
  });

  /**
   * A knowledge base whose `.bevelignore` predates AGENTS.md: top-up adds the
   * file, and the ignore file already there knows nothing of the name — so
   * without this the conventions doc starts showing in the file tree and the
   * agent view on every existing deployment. We created the mismatch by adding
   * the file, so top-up closes it.
   *
   * This is the path for a KB that had NO conventions file to begin with. One
   * that carries a pre-rename `CLAUDE.md` is handled earlier, by the rename —
   * which retargets the ignore line rather than appending beside it (see
   * 'legacy conventions file → renamed in place').
   */
  describe('the pre-rename ignore file', () => {
    const legacy = (ignore: string): Record<string, string> => ({
      'KnowledgeBase/.gitkeep': '',
      'Groups/.gitkeep': '',
      'access.md': '---\nwrite:\n  - Admin\n---\n',
      'roles.yaml': 'roles:\n  Admin:\n    - a@example.com\n',
      '.gitignore': '',
      '.bevelignore': ignore,
    });

    it('learns about AGENTS.md when top-up adds one', async () => {
      // No conventions file of any name, so nothing to rename — the required-file
      // scan lays down the template's AGENTS.md, and the ignore file follows it.
      const upstream = await seededUpstream(
        [DEFAULT_BRANCH],
        legacy('# mine\n.gitignore\nCLAUDE.md\nMy-Own-Rule/\n'),
      );
      const repoDir = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(repoDir, DEFAULT_BRANCH);

      const dir = await checkout(root, upstream, DEFAULT_BRANCH);
      expect(await exists(path.join(dir, 'AGENTS.md'))).toBe(true);
      const ignore = await fs.readFile(path.join(dir, '.bevelignore'), 'utf8');
      expect(ignore.split('\n').map((l) => l.trim())).toContain('AGENTS.md');
      // The operator's own rules survive — this appends, it does not rewrite.
      expect(ignore).toContain('My-Own-Rule/');
      expect(ignore).toContain('CLAUDE.md');
    });

    it('is left alone when it already knows the pattern', async () => {
      const upstream = await seededUpstream([DEFAULT_BRANCH], legacy('AGENTS.md\n'));
      const repoDir = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(repoDir, DEFAULT_BRANCH);

      const dir = await checkout(root, upstream, DEFAULT_BRANCH);
      const ignore = await fs.readFile(path.join(dir, '.bevelignore'), 'utf8');
      expect(ignore.split('\n').filter((l) => l.trim() === 'AGENTS.md')).toHaveLength(1);
    });
  });

  /**
   * A distribution that owns folders core has no feature for — the agentic
   * execution layer's `Data/`, `Agents/`, `Pipelines/` — claims them through
   * `extraDirs` (wired from `CorePorts.kbExtraRootDirs`).
   *
   * The point is that claiming a root does NOT require forking the packaged
   * template: `TEMPLATE_DIR` here is core's, which carries no entry for any of
   * these, and the folders still arrive. Their `.gitkeep` is written rather
   * than copied for exactly that reason.
   */
  describe('distribution-reserved roots', () => {
    it('creates extra roots that the template knows nothing about', async () => {
      const upstream = await emptyUpstream();
      await makeSeeder(upstream, ADMINS, ['Data', 'Agents', 'Pipelines']).ensureRemoteSeeded();

      const dir = await checkout(root, upstream, DEFAULT_BRANCH);
      // Core's two, still there.
      expect(await exists(path.join(dir, 'KnowledgeBase/.gitkeep'))).toBe(true);
      expect(await exists(path.join(dir, 'Groups/.gitkeep'))).toBe(true);
      // …and the three this distribution asked for.
      for (const claimed of ['Data', 'Agents', 'Pipelines']) {
        expect(await exists(path.join(dir, `${claimed}/.gitkeep`))).toBe(true);
      }
    });

    /**
     * The name is joined onto the repo root and onto `<dir>/.gitkeep`, so a
     * separator or a `..` would write outside the repo being seeded. Refused
     * at CONSTRUCTION, so a bad value surfaces at boot rather than part-way
     * through seeding somebody's knowledge base.
     */
    it.each(['../escape', 'nested/dir', '/absolute', '..', '.', ''])(
      'refuses %j as a reserved root',
      (bad) => {
        expect(() => makeSeeder('unused', ADMINS, [bad])).toThrow(/single path segment/);
      },
    );

    /**
     * Being reserved is what makes a name worth claiming — the file tree
     * renders it as its own root instead of folding it into Knowledge — so the
     * names in `kb-layout.ts` must stay ACCEPTED here. A guard that rejected
     * them would reject the only real use of this argument.
     */
    /**
     * A root named after a required FILE is a typo whose outcome is silence:
     * the file is laid down first in both seed paths, so `ensureRequiredDirs`
     * finds the path taken and skips it, and the directory never appears with
     * nothing said about why. Refused at construction instead.
     */
    it.each(['access.md', 'AGENTS.md', '.bevelignore', '.gitignore'])(
      'refuses %j, which is a required file rather than a root',
      (collide) => {
        expect(() => makeSeeder('unused', ADMINS, [collide])).toThrow(/collides with a required file/);
      },
    );

    it('accepts the reserved names a distribution actually claims', () => {
      expect(() => makeSeeder('unused', ADMINS, ['Data', 'Agents', 'Pipelines'])).not.toThrow();
    });

    /**
     * A FILE named `Groups` used to satisfy the presence check — `fs.access`
     * answers "is there something here?" — so the seeder skipped it, said
     * nothing, and left a knowledge base permanently missing a root it claims
     * to guarantee. Now it says so.
     *
     * Surfaces as a warning rather than a crash on this path: `topUpWorkspace`
     * is documented best-effort and must never block a user from loading a
     * branch. The point is that the condition is REPORTED at all.
     */
    it('refuses a required root that exists as a file, instead of skipping it', async () => {
      const upstream = await seededUpstream([DEFAULT_BRANCH], {
        'AGENTS.md': '# x',
        'access.md': 'read:\n  - everyone\n',
        '.bevelignore': '',
        '.gitignore': '',
        'KnowledgeBase/.gitkeep': '',
        // Not a folder.
        Groups: 'this is a file, not the groups root',
      });
      const repoDir = await checkout(root, upstream, DEFAULT_BRANCH);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await makeSeeder(upstream).topUpWorkspace(repoDir, DEFAULT_BRANCH);
        expect(warn.mock.calls.flat().join(' ')).toMatch(/Groups.*not a directory/);
      } finally {
        warn.mockRestore();
      }
      // …and it did not quietly replace the file either.
      expect((await fs.lstat(path.join(repoDir, 'Groups'))).isFile()).toBe(true);
    });
  });

  /**
   * The conventions file was called CLAUDE.md before it was called AGENTS.md.
   * A knowledge base seeded under the old name is a customer git repo we do not
   * otherwise rewrite, so the rename only reaches it here — and it has to move
   * the file, not replace it: the content is the author's, not the template's.
   */
  describe('legacy conventions file → renamed in place', () => {
    /** A KB as it looked before the rename: authored CLAUDE.md, ignore line to match. */
    async function preRenameUpstream(claudeContent = 'AUTHORED CONVENTIONS'): Promise<string> {
      return seededUpstream(PROTECTED, {
        'roles.yaml': 'roles:\n  Admin:\n    - keep@example.com\n',
        'access.md': 'existing',
        'CLAUDE.md': claudeContent,
        '.bevelignore': '# hide the conventions file\nCLAUDE.md\nroles.yaml\n',
        '.gitignore': 'x',
        'KnowledgeBase/Real/Knowledge/.gitkeep': '',
        'Groups/.gitkeep': '',
      });
    }

    it('renames CLAUDE.md to AGENTS.md, keeping the author’s content', async () => {
      const upstream = await preRenameUpstream();
      const repoDir = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(repoDir, DEFAULT_BRANCH);

      const dir = await checkout(root, upstream, DEFAULT_BRANCH);
      expect(await exists(path.join(dir, 'CLAUDE.md'))).toBe(false);
      // Moved, not replaced by the template — the author's words survive.
      expect(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).toBe('AUTHORED CONVENTIONS');
    });

    it('records it as a rename so history follows the file', async () => {
      const upstream = await preRenameUpstream();
      const repoDir = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(repoDir, DEFAULT_BRANCH);

      const dir = await checkout(root, upstream, DEFAULT_BRANCH);
      const status = await git(dir, ['show', '--name-status', '--find-renames', 'HEAD']);
      expect(status).toMatch(/^R\d*\s+CLAUDE\.md\s+AGENTS\.md$/m);
    });

    /**
     * Retargeted, not appended to. The rename leaves the KB with no CLAUDE.md
     * at all, so the line naming it is dead — and the top-up's append path
     * (`mergeIgnorePattern`) never runs here, because by the time the
     * required-file scan looks, AGENTS.md is already present.
     */
    it('retargets the .bevelignore line so the file stays hidden', async () => {
      const upstream = await preRenameUpstream();
      const repoDir = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(repoDir, DEFAULT_BRANCH);

      const dir = await checkout(root, upstream, DEFAULT_BRANCH);
      const ignore = await fs.readFile(path.join(dir, '.bevelignore'), 'utf8');
      // Trimmed: git hands the file back with CRLF on Windows, and the rewrite
      // preserves whatever line endings the author's file already had.
      const entries = ignore.split('\n').map((l) => l.trim());
      expect(entries).toContain('AGENTS.md');
      expect(entries).not.toContain('CLAUDE.md');
      // Only the exact-match line is rewritten — a comment naming the old file
      // is prose, not a pattern, and is left as the author wrote it.
      expect(ignore).toContain('# hide the conventions file');
      expect(ignore).toContain('roles.yaml');
    });

    it('leaves both files alone when the KB already has an AGENTS.md', async () => {
      // Nothing here is safe to overwrite: both files have content someone wrote.
      const upstream = await seededUpstream(PROTECTED, {
        'roles.yaml': 'roles:\n  Admin:\n    - keep@example.com\n',
        'access.md': 'existing',
        'CLAUDE.md': 'OLD',
        'AGENTS.md': 'NEW',
        '.bevelignore': 'CLAUDE.md\n',
        '.gitignore': 'x',
        'KnowledgeBase/Real/Knowledge/.gitkeep': '',
        'Groups/.gitkeep': '',
      });
      const repoDir = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(repoDir, DEFAULT_BRANCH);

      const dir = await checkout(root, upstream, DEFAULT_BRANCH);
      expect(await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('OLD');
      expect(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).toBe('NEW');
    });

    it('is idempotent — a migrated branch makes no second commit', async () => {
      const upstream = await preRenameUpstream();
      const first = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(first, DEFAULT_BRANCH);
      const after1 = await headCommitCount(root, upstream, DEFAULT_BRANCH);

      const second = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(second, DEFAULT_BRANCH);
      const after2 = await headCommitCount(root, upstream, DEFAULT_BRANCH);

      expect(after2).toBe(after1);
    });
  });
});
