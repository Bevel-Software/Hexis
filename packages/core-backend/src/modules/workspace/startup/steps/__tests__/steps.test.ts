import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KbStartupRunner } from '../../kb-startup-runner.js';
import type { OnServerStart, ServerStartContext, StepResult } from '../../on-server-start.js';
import { GroupsToPluginsStep } from '../groups-to-plugins.step.js';
import { RolesYamlStep } from '../roles-yaml.step.js';
import { TemplateFilesStep } from '../template-files.step.js';
import { defaultKbTemplateDir } from '../../../../../assets.js';

const execFileAsync = promisify(execFile);

/**
 * Integration tests for the three core steps THROUGH the real runner — the
 * ops they declare only matter as the tree the runner commits and pushes.
 * The deep migration edge cases stay covered by plugins-migration.test.ts
 * against the in-place module; these cover the buffered step's behavior.
 */

/** The real seed template shipped inside this package (see assets.ts). */
const TEMPLATE_DIR = defaultKbTemplateDir();

const PROTECTED = ['current-company-state', 'target-company-state'];
const DEFAULT_BRANCH = 'current-company-state';

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

let root: string;
let upstream: string;
let workspacesRoot: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-steps-'));
  workspacesRoot = path.join(root, 'workspaces');
  await fs.mkdir(workspacesRoot, { recursive: true });
  upstream = path.join(root, 'upstream.git');
  await git(root, ['init', '--bare', '-b', DEFAULT_BRANCH, upstream]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

/** A populated upstream carrying `files`: one commit, both protected refs. Returns the seed clone. */
async function seedUpstream(files: Record<string, string>): Promise<string> {
  const seed = path.join(root, '.seed');
  await fs.mkdir(seed, { recursive: true });
  await git(seed, ['init', '-b', DEFAULT_BRANCH]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(seed, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  await git(seed, ['add', '-A']);
  await git(seed, ['commit', '-m', 'init']);
  await git(seed, ['branch', PROTECTED[1]!]);
  await git(seed, ['remote', 'add', 'origin', upstream]);
  await git(seed, ['push', 'origin', ...PROTECTED]);
  return seed;
}

function makeRunner(steps: OnServerStart[]) {
  return new KbStartupRunner({
    kbRepoUrl: () => upstream,
    gitUsername: () => 'x-access-token',
    workspacesRoot,
    kbDirName: 'knowledge-base',
    templateDir: TEMPLATE_DIR,
    defaultBranch: () => DEFAULT_BRANCH,
    protectedBranches: () => PROTECTED,
    seedAdminEmails: ['admin@example.com'],
    steps,
    buildSeedTree: async (dir: string) => {
      await fs.writeFile(path.join(dir, 'seeded.md'), 'from template', 'utf8');
    },
  });
}

function step(name: string, run: (ctx: ServerStartContext) => Promise<StepResult>): OnServerStart {
  return { name, run };
}

async function checkout(branch: string): Promise<string> {
  const dir = path.join(root, `checkout-${branch.replace(/\W/g, '-')}-${Math.random().toString(36).slice(2)}`);
  await git(root, ['clone', '-b', branch, upstream, dir]);
  return dir;
}

async function exists(dir: string, rel: string): Promise<boolean> {
  return fs.access(path.join(dir, rel)).then(() => true, () => false);
}

const norm = (text: string) => text.replace(/\r\n?/g, '\n');

async function template(name: string): Promise<string> {
  return fs.readFile(path.join(TEMPLATE_DIR, name), 'utf8');
}

/** Every required file + reserved root already present, from the real template. */
async function fullScaffold(): Promise<Record<string, string>> {
  return {
    'access.md': await template('access.md'),
    'AGENTS.md': await template('AGENTS.md'),
    '.bevelignore': await template('.bevelignore'),
    '.gitignore': await template('gitignore.template'),
    'KnowledgeBase/.gitkeep': '',
    'Plugins/.gitkeep': '',
  };
}

describe('TemplateFilesStep', () => {
  it('adds the missing scaffolding — .gitignore arriving from its packable template spelling', async () => {
    await seedUpstream({ 'marker.txt': 'seeded' });
    await makeRunner([new TemplateFilesStep()]).runAll();

    for (const b of PROTECTED) {
      const dir = await checkout(b);
      for (const rel of ['access.md', 'AGENTS.md', '.bevelignore', '.gitignore']) {
        expect(await exists(dir, rel), `${b}: ${rel}`).toBe(true);
      }
      // The packaged template cannot ship a literal .gitignore (npm strips
      // them); the step must have read gitignore.template and written the
      // real name.
      expect(norm(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'))).toBe(
        norm(await template('gitignore.template')),
      );
      // Reserved roots materialize as <dir>/.gitkeep.
      expect(await exists(dir, 'KnowledgeBase/.gitkeep')).toBe(true);
      expect(await exists(dir, 'Plugins/.gitkeep')).toBe(true);
      const subject = (await git(dir, ['log', '--format=%s', '-1'])).trim();
      expect(subject).toMatch(/^Add missing KB scaffolding: /);
      expect(subject).toContain('.gitignore');
    }
  });

  it('replaces a drifted AGENTS.md, and says so when that is the only change', async () => {
    await seedUpstream({ ...(await fullScaffold()), 'AGENTS.md': 'stale conventions\n' });
    await makeRunner([new TemplateFilesStep()]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'))).toBe(norm(await template('AGENTS.md')));
    const subject = (await git(dir, ['log', '--format=%s', '-1'])).trim();
    expect(subject).toBe('Update AGENTS.md to the current platform template');
  });

  it('treats a CRLF checkout of identical AGENTS.md content as current — no churn commit', async () => {
    const scaffold = await fullScaffold();
    scaffold['AGENTS.md'] = norm(scaffold['AGENTS.md']!).replace(/\n/g, '\r\n');
    await seedUpstream(scaffold);
    await makeRunner([new TemplateFilesStep()]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect((await git(dir, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1'); // init only
  });
});

describe('RolesYamlStep', () => {
  it('generates roles.yaml with the configured admins on every protected branch', async () => {
    await seedUpstream({ 'marker.txt': 'seeded' });
    await makeRunner([new RolesYamlStep(['admin@example.com'])]).runAll();

    for (const b of PROTECTED) {
      const dir = await checkout(b);
      // norm: a Windows checkout may hand the file back CRLF.
      const roles = norm(await fs.readFile(path.join(dir, 'roles.yaml'), 'utf8'));
      expect(roles).toContain('# Identity → role mapping for access control.');
      expect(roles).toContain('  Admin:\n    - admin@example.com');
      const subject = (await git(dir, ['log', '--format=%s', '-1'])).trim();
      expect(subject).toBe('Add roles.yaml granting Admin to the configured seed admins');
    }
  });

  it('declares a skip when the file is missing and no admins are configured', async () => {
    await seedUpstream({ 'marker.txt': 'seeded' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await makeRunner([new RolesYamlStep([])]).runAll(); // resolves — a declared skip, not a failure

    expect(warn.mock.calls.some((c) => String(c[0]).includes('roles-yaml: skipped'))).toBe(true);
    const dir = await checkout(DEFAULT_BRANCH);
    expect(await exists(dir, 'roles.yaml')).toBe(false);
    expect((await git(dir, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
  });
});

describe('GroupsToPluginsStep', () => {
  it('migrates a Groups/ tree to the Plugins layout — on the protected branches AND a draft', async () => {
    const seed = await seedUpstream({
      'marker.txt': 'seeded',
      '.bevelignore': 'Groups/\n',
      'Groups/GTM/access.md': '---\nread:\n  - everyone\n---\n',
      'Groups/GTM/outreach/SKILL.md': '---\ndescription: Outreach.\n---\n# Outreach\n',
      'Groups/GTM/web-search.tool': JSON.stringify(
        { name: 'web_search', type: 'http', url: 'https://search.example/api' },
        null,
        2,
      ),
      'Groups/GTM/notion.tool': JSON.stringify(
        { name: 'notion', type: 'mcp', url: 'https://mcp.notion.com/mcp' },
        null,
        2,
      ),
    });
    // A draft carrying the same pre-migration tree: allBranches scope means it
    // migrates alongside its target, keeping its CR diff to the user's changes.
    await git(seed, ['checkout', '-b', 'alice/draft']);
    await git(seed, ['push', 'origin', 'alice/draft']);

    await makeRunner([new GroupsToPluginsStep()]).runAll();

    for (const b of [DEFAULT_BRANCH, 'alice/draft']) {
      const dir = await checkout(b);
      expect(await exists(dir, 'Groups'), `${b}: Groups/ gone`).toBe(false);
      expect(await exists(dir, 'Plugins/GTM/access.md')).toBe(true);
      expect(await exists(dir, 'Plugins/GTM/skills/outreach/SKILL.md')).toBe(true);
      // http manual MOVED as a .tool; mcp manual CONVERTED and its source deleted.
      expect(await exists(dir, 'Plugins/GTM/software.bevel.hexis/tools/web-search.tool')).toBe(true);
      expect(await exists(dir, 'Plugins/GTM/notion.tool')).toBe(false);
      expect(await exists(dir, 'Plugins/GTM/software.bevel.hexis/tools/notion.tool')).toBe(false);
      const mcp = JSON.parse(await fs.readFile(path.join(dir, 'Plugins/GTM/mcp.json'), 'utf8'));
      expect(mcp.mcpServers.notion).toEqual({ type: 'streamable-http', url: 'https://mcp.notion.com/mcp' });
      const manifest = JSON.parse(await fs.readFile(path.join(dir, 'Plugins/GTM/plugin.json'), 'utf8'));
      expect(manifest.name).toBe('gtm');
      // The rename's companion edit: the stale ignore rule now names Plugins/.
      const ignore = await fs.readFile(path.join(dir, '.bevelignore'), 'utf8');
      expect(ignore).toContain('Plugins/');
      expect(ignore).not.toContain('Groups/');
    }

    const dir = await checkout(DEFAULT_BRANCH);
    const log = await git(dir, ['log', '--format=%s%n%b', '-1']);
    expect(log).toContain('Move Groups/ to Plugins/ (Agent Plugins layout)'); // the subject
    expect(log).toContain('Groups/ → Plugins/');
    expect(log).toContain('notion.tool converted to an mcp.json entry');
    expect(log).toContain('web-search.tool → software.bevel.hexis/tools/web-search.tool');
  });

  it('refuses a branch carrying BOTH roots — nothing moves, and the note names the state', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedUpstream({
      'Groups/A/x.md': 'legacy',
      'Plugins/B/y.md': 'new',
    });
    await makeRunner([
      new GroupsToPluginsStep(),
      // A later step dirties the branch so the refusal note surfaces in the commit.
      step('dirty', async (ctx) => {
        for (const b of await ctx.protectedBranches()) {
          b.write('z.md', 'z');
          b.note('Add z.md');
        }
        return { outcome: 'ok' };
      }),
    ]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    // Both trees untouched — the migration guessed at nothing.
    expect(await fs.readFile(path.join(dir, 'Groups/A/x.md'), 'utf8')).toBe('legacy');
    expect(await fs.readFile(path.join(dir, 'Plugins/B/y.md'), 'utf8')).toBe('new');
    expect(await exists(dir, 'Plugins/B/plugin.json')).toBe(false);
    const log = await git(dir, ['log', '--format=%s%n%b', '-1']);
    expect(log).toContain('Groups/ and Plugins/ both exist — merge by hand');
  });
});
