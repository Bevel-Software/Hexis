import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

function makeSeeder(upstream: string, admins: readonly string[] = ADMINS): KbSeedService {
  return new KbSeedService(upstream, TEMPLATE_DIR, PROTECTED, DEFAULT_BRANCH, admins);
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
        // The well-known KB roots are seeded (kept present via their .gitkeep).
        // `Groups/` replaced the old `Skills/` + `Tools/` pair.
        expect(await exists(path.join(dir, 'KnowledgeBase/.gitkeep'))).toBe(true);
        expect(await exists(path.join(dir, 'Groups/.gitkeep'))).toBe(true);

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
