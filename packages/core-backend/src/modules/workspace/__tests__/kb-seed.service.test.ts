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
        // The template ships this one under the packable spelling
        // `gitignore.template` (npm strips literal `.gitignore` files from
        // tarballs); the seed must land it under the REAL name only.
        expect(await exists(path.join(dir, '.gitignore'))).toBe(true);
        expect(await exists(path.join(dir, 'gitignore.template'))).toBe(false);
        // Core's two roots are seeded (kept present via their .gitkeep).
        expect(await exists(path.join(dir, 'KnowledgeBase/.gitkeep'))).toBe(true);
        expect(await exists(path.join(dir, 'Plugins/.gitkeep'))).toBe(true);
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

    it('a literal .gitignore in a custom template beats the packable spelling', async () => {
      // A distribution's own KB_TEMPLATE_DIR (or this repo's tree in a
      // Docker build) may carry the real file; the fallback must never
      // shadow or clobber it.
      const custom = path.join(root, 'custom-template');
      await fs.cp(TEMPLATE_DIR, custom, { recursive: true });
      await fs.writeFile(path.join(custom, '.gitignore'), 'literal-wins\n', 'utf8');
      const upstream = await emptyUpstream();
      await new KbSeedService(
        upstream, custom, PROTECTED, DEFAULT_BRANCH, ADMINS, 'x-access-token', [],
      ).ensureRemoteSeeded();
      const dir = await checkout(root, upstream, DEFAULT_BRANCH);
      // Normalized: the verifying checkout may apply autocrlf.
      const gitignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
      expect(gitignore.replace(/\r\n/g, '\n')).toBe('literal-wins\n');
      expect(await exists(path.join(dir, 'gitignore.template'))).toBe(false);
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
        'Plugins/.gitkeep': '',
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
        'Plugins/.gitkeep': '',
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

    it('replaces an edited AGENTS.md with the current template — the file is managed', async () => {
      const upstream = await seededUpstream(PROTECTED, {
        'roles.yaml': 'roles:\n  Admin:\n    - keep@example.com\n',
        'AGENTS.md': '# my own conventions\n',
        '.bevelignore': 'AGENTS.md\n',
        '.gitignore': '',
        'access.md': 'CUSTOM ACCESS RULES',
        'KnowledgeBase/Real/Knowledge/.gitkeep': '',
        'Plugins/.gitkeep': '',
      });

      const repoDir = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(repoDir, DEFAULT_BRANCH);

      const dir = await checkout(root, upstream, DEFAULT_BRANCH);
      const agents = await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
      // The template's copy, not the edit — and the template says WHY, so the
      // overwrite is a stated contract rather than a surprise.
      expect(agents).not.toContain('my own conventions');
      expect(agents).toContain('managed by the platform');
      // Everything the platform does NOT manage is preserved verbatim.
      expect(await fs.readFile(path.join(dir, 'access.md'), 'utf8')).toBe('CUSTOM ACCESS RULES');
      const log = await git(dir, ['log', '-1', '--pretty=%s']);
      expect(log.trim()).toBe('Update AGENTS.md to the current platform template');
    });

    it('a current AGENTS.md makes no refresh commit, even with CRLF endings', async () => {
      const template = await fs.readFile(
        path.join(__dirname, '../../../../kb-template/AGENTS.md'),
        'utf8',
      );
      const upstream = await seededUpstream(PROTECTED, {
        'roles.yaml': 'roles:\n  Admin:\n    - keep@example.com\n',
        // Same content, Windows endings — must read as "same", or the managed
        // refresh would commit churn on every boot forever.
        //
        // `\r?\n`, not `\n`: on a Windows checkout (`core.autocrlf=true`) the
        // template already HAS CRLF, so converting every `\n` would produce
        // `\r\r\n` — a file that differs from the template for real, failing
        // this test for a reason that has nothing to do with what it asserts.
        // Matching the optional `\r` normalizes first, so the fixture is
        // exactly-CRLF on every platform.
        'AGENTS.md': template.replace(/\r?\n/g, '\r\n'),
        '.bevelignore': 'AGENTS.md\n',
        '.gitignore': '',
        'access.md': 'CUSTOM ACCESS RULES',
        'KnowledgeBase/Real/Knowledge/.gitkeep': '',
        'Plugins/.gitkeep': '',
      });

      const first = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(first, DEFAULT_BRANCH);
      const after = await headCommitCount(root, upstream, DEFAULT_BRANCH);
      // Only the pre-seed commit: nothing was missing, nothing was stale.
      expect(after).toBe(1);
    });

    it('topUpWorkspace is idempotent — a second load makes no new commit', async () => {
      const upstream = await seededUpstream(PROTECTED, {
        'roles.yaml': 'roles:\n  Admin:\n    - keep@example.com\n',
        'KnowledgeBase/Real/Knowledge/.gitkeep': '',
        'Plugins/.gitkeep': '',
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

    it('a note-only migration outcome stages nothing and raises no top-up warning', async () => {
      const template = await fs.readFile(
        path.join(__dirname, '../../../../kb-template/AGENTS.md'),
        'utf8',
      );
      const upstream = await seededUpstream(PROTECTED, {
        'roles.yaml': 'roles:\n  Admin:\n    - keep@example.com\n',
        'access.md': 'x',
        'AGENTS.md': template,
        '.bevelignore': 'AGENTS.md\nPlugins/\n',
        '.gitignore': '',
        'KnowledgeBase/Real/Knowledge/.gitkeep': '',
        'Plugins/GTM/access.md': 'write:\n  - Admin\n',
        // An unparsable manifest keeps this manual a `.tool` — its variables
        // have nowhere to go. The migration NOTES the refusal every run and
        // changes nothing; staging on the note used to reach `git commit`
        // with an empty index and warn about it on every boot.
        'Plugins/GTM/plugin.json': '{ not json at all',
        'Plugins/GTM/vendor.tool': JSON.stringify({
          name: 'vendor',
          type: 'mcp',
          url: 'https://mcp.vendor.example/mcp',
          variables: [{ name: 'VENDOR_KEY', scope: 'user' }],
        }),
      });
      const repoDir = await checkout(root, upstream, DEFAULT_BRANCH);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await makeSeeder(upstream).topUpWorkspace(repoDir, DEFAULT_BRANCH);
        expect(warn.mock.calls.flat().join(' ')).not.toMatch(/top-up/i);
      } finally {
        warn.mockRestore();
      }
      // Only the pre-seed commit — a note is not a change.
      expect(await headCommitCount(root, upstream, DEFAULT_BRANCH)).toBe(1);
    });

    it('the root rename rewrites the stale .bevelignore rule and commits it along', async () => {
      const template = await fs.readFile(
        path.join(__dirname, '../../../../kb-template/AGENTS.md'),
        'utf8',
      );
      const upstream = await seededUpstream(PROTECTED, {
        'roles.yaml': 'roles:\n  Admin:\n    - keep@example.com\n',
        'access.md': 'x',
        'AGENTS.md': template,
        // The pre-rename rule: without the rewrite the migrated KB has a rule
        // for a root that no longer exists and none for the one that does.
        '.bevelignore': 'AGENTS.md\nGroups/\n',
        '.gitignore': '',
        'KnowledgeBase/Real/Knowledge/.gitkeep': '',
        'Groups/GTM/access.md': 'write:\n  - Admin\n',
      });
      const repoDir = await checkout(root, upstream, DEFAULT_BRANCH);
      await makeSeeder(upstream).topUpWorkspace(repoDir, DEFAULT_BRANCH);

      // An independent clone proves the rewrite was STAGED (the ignore file
      // is a repo-root path outside the two roots' pathspecs) and pushed.
      const dir = await checkout(root, upstream, DEFAULT_BRANCH);
      expect(await exists(path.join(dir, 'Plugins/GTM/access.md'))).toBe(true);
      const ignore = await fs.readFile(path.join(dir, '.bevelignore'), 'utf8');
      expect(ignore.split('\n').map((l) => l.trim())).toContain('Plugins/');
      expect(ignore).not.toContain('Groups/');
      expect(ignore).toContain('AGENTS.md');
      const log = await git(dir, ['log', '-1', '--pretty=%s']);
      expect(log.trim()).toBe('Move Groups/ to Plugins/ (Agent Plugins layout)');
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
  /**
   * A knowledge base seeded before AGENTS.md was named that: top-up adds the
   * file, and the `.bevelignore` already there lists only the old name — so
   * without this the conventions doc starts showing in the file tree and the
   * agent view on every existing deployment. We created the mismatch by adding
   * the file, so top-up closes it.
   */
  describe('the pre-rename ignore file', () => {
    const legacy = (ignore: string): Record<string, string> => ({
      'KnowledgeBase/.gitkeep': '',
      'Plugins/.gitkeep': '',
      'access.md': '---\nwrite:\n  - Admin\n---\n',
      'roles.yaml': 'roles:\n  Admin:\n    - a@example.com\n',
      '.gitignore': '',
      '.bevelignore': ignore,
    });

    it('learns about AGENTS.md when top-up adds one', async () => {
      const upstream = await seededUpstream([DEFAULT_BRANCH], {
        ...legacy('# mine\n.gitignore\nCLAUDE.md\nMy-Own-Rule/\n'),
        'CLAUDE.md': '# conventions',
      });
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

  describe('distribution-reserved roots', () => {
    it('creates extra roots that the template knows nothing about', async () => {
      const upstream = await emptyUpstream();
      await makeSeeder(upstream, ADMINS, ['Data', 'Agents', 'Pipelines']).ensureRemoteSeeded();

      const dir = await checkout(root, upstream, DEFAULT_BRANCH);
      // Core's two, still there.
      expect(await exists(path.join(dir, 'KnowledgeBase/.gitkeep'))).toBe(true);
      expect(await exists(path.join(dir, 'Plugins/.gitkeep'))).toBe(true);
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
     * A FILE named `Plugins` used to satisfy the presence check — `fs.access`
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
        Plugins: 'this is a file, not the plugins root',
      });
      const repoDir = await checkout(root, upstream, DEFAULT_BRANCH);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await makeSeeder(upstream).topUpWorkspace(repoDir, DEFAULT_BRANCH);
        expect(warn.mock.calls.flat().join(' ')).toMatch(/Plugins.*not a directory/);
      } finally {
        warn.mockRestore();
      }
      // …and it did not quietly replace the file either.
      expect((await fs.lstat(path.join(repoDir, 'Plugins'))).isFile()).toBe(true);
    });

    /**
     * A non-protected branch is somebody's change-in-waiting — a suggestions
     * branch behind an open change request, a personal draft — and a
     * scaffolding commit landing on it shows up as noise in their diff
     * against the default branch (a stray scaffolding file riding along in a
     * skill proposal was the observed symptom). Whatever the protected
     * branches lack, they get when THEY load; drafts fork from them.
     */
    it('topUpWorkspace leaves non-protected branches alone', async () => {
      const upstream = await seededUpstream(PROTECTED, {
        'roles.yaml': 'roles:\n  Admin:\n    - keep@example.com\n',
        'KnowledgeBase/Real/Knowledge/.gitkeep': '',
        'Plugins/.gitkeep': '',
      });
      // Branch a suggestion off the default and load it.
      const seed = await checkout(root, upstream, DEFAULT_BRANCH);
      await git(seed, ['checkout', '-b', 'suggestions/alice/knowledge']);
      await git(seed, ['push', 'origin', 'suggestions/alice/knowledge']);

      const before = await headCommitCount(root, upstream, 'suggestions/alice/knowledge');
      const repoDir = await checkout(root, upstream, 'suggestions/alice/knowledge');
      await makeSeeder(upstream).topUpWorkspace(repoDir, 'suggestions/alice/knowledge');

      // No scaffolding commit: the branch's diff against the default branch
      // stays exactly what its author put there.
      const after = await headCommitCount(root, upstream, 'suggestions/alice/knowledge');
      expect(after).toBe(before);
      const dir = await checkout(root, upstream, 'suggestions/alice/knowledge');
      expect(await exists(path.join(dir, 'AGENTS.md'))).toBe(false);
    });
  });
});
