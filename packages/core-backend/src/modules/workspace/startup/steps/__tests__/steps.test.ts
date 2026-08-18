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
import { renderRolesYaml } from '../../../../access/render-roles-yaml.js';
import { TemplateFilesStep } from '../template-files.step.js';
import { buildSeedTree } from '../seed-tree.js';
import { defaultKbTemplateDir } from '../../../../../assets.js';

const execFileAsync = promisify(execFile);

/**
 * Integration tests for the three core steps THROUGH the real runner — the
 * ops they declare only matter as the tree the runner commits and pushes.
 * The deep migration edge cases (ported from the deleted in-place module's
 * suite) live in the "migration edge cases" describe below.
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

function makeRunner(steps: OnServerStart[], templateDir: string = TEMPLATE_DIR) {
  return new KbStartupRunner({
    kbRepoUrl: () => upstream,
    gitUsername: () => 'x-access-token',
    workspacesRoot,
    kbDirName: 'knowledge-base',
    templateDir,
    defaultBranch: () => DEFAULT_BRANCH,
    protectedBranches: () => PROTECTED,
    seedAdminEmails: ['admin@example.com'],
    steps,
    buildSeedTree: async (dir: string) => {
      await fs.writeFile(path.join(dir, 'seeded.md'), 'from template', 'utf8');
      return [];
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

  it('rejects .git — any case — as a reserved root name', async () => {
    for (const bad of ['.git', '.GIT', '.Git']) {
      expect(() => new TemplateFilesStep([bad]), bad).toThrow(/must not be "\.git"/);
    }
  });

  it('appends the AGENTS.md rule to a custom template\'s .bevelignore that lacks it, at declaration time', async () => {
    // A distribution's own template whose ignore file does not carry the rule
    // the on-disk merge assumes: the merge only runs against an EXISTING file,
    // so the declared content itself must arrive with the rule in it.
    const customTemplate = path.join(root, 'custom-template');
    await fs.mkdir(customTemplate, { recursive: true });
    await fs.writeFile(path.join(customTemplate, 'AGENTS.md'), await template('AGENTS.md'), 'utf8');
    await fs.writeFile(path.join(customTemplate, '.bevelignore'), '# custom\nMyStuff/\n', 'utf8');
    const scaffold = await fullScaffold();
    delete scaffold['.bevelignore']; // the one file the step will declare from the template
    await seedUpstream(scaffold);

    await makeRunner([new TemplateFilesStep()], customTemplate).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    const lines = norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8')).split('\n').map((l) => l.trim());
    expect(lines).toContain('MyStuff/'); // the operator's rules survive
    expect(lines).toContain('AGENTS.md'); // the platform's rule was appended
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

  it('throws — naming the branch and path — when a directory squats the roles.yaml name', async () => {
    // A dir (or symlink) named roles.yaml would read as "present" to a
    // skip-if-present check, reporting success over a KB whose access roster
    // cannot be read. Fail closed instead.
    await seedUpstream({ 'roles.yaml/placeholder.txt': 'squatter' });
    await expect(makeRunner([new RolesYamlStep(['admin@example.com'])]).runAll()).rejects.toThrow(
      /"roles\.yaml" on branch "current-company-state" exists but is not a regular file \(directory\)/,
    );
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

describe('renderRolesYaml', () => {
  it('renders trimmed admin emails', () => {
    const yaml = renderRolesYaml(['  admin@example.com  ']);
    expect(yaml).toContain('  Admin:\n    - admin@example.com\n');
  });

  it('throws on an email that would corrupt roles.yaml instead of rendering an adminless file', () => {
    // Empty after trim, a YAML comment, embedded whitespace/newline — each
    // would render a file with no working Admin, silently.
    for (const bad of ['', '   ', '#admin@example.com', 'admin@example.com\nextra', 'a b@example.com']) {
      expect(() => renderRolesYaml([bad]), JSON.stringify(bad)).toThrow(/admin email/i);
    }
  });

  it('throws on anything the real access parser would reject, via parse-back', () => {
    // Passes the character-level checks above but fails the parser's email
    // grammar — e.g. an address-book "Name <email>" shape or a non-email.
    for (const bad of ['<admin@example.com>', 'not-an-email']) {
      expect(() => renderRolesYaml([bad]), JSON.stringify(bad)).toThrow(/would not parse/i);
    }
  });
});

describe('buildSeedTree', () => {
  it('skips .git at any depth of the template walk, and names the paths it generated', async () => {
    const templateDir = path.join(root, 'seed-template');
    // A KB_TEMPLATE_DIR that is itself a git working tree: .git at the root
    // and (pathologically) nested must never be seeded into the KB.
    await fs.mkdir(path.join(templateDir, '.git'), { recursive: true });
    await fs.writeFile(path.join(templateDir, '.git', 'config'), '[core]', 'utf8');
    await fs.mkdir(path.join(templateDir, 'docs', '.git'), { recursive: true });
    await fs.writeFile(path.join(templateDir, 'docs', '.git', 'HEAD'), 'ref:', 'utf8');
    await fs.writeFile(path.join(templateDir, 'docs', 'guide.md'), 'guide', 'utf8');
    await fs.writeFile(path.join(templateDir, 'access.md'), 'policy', 'utf8');

    const dest = path.join(root, 'seed-dest');
    await fs.mkdir(dest, { recursive: true });
    const generated = await buildSeedTree(templateDir, [], ['admin@example.com'])(dest);

    expect(await exists(dest, '.git')).toBe(false);
    expect(await exists(dest, 'docs/.git')).toBe(false);
    expect(await fs.readFile(path.join(dest, 'docs/guide.md'), 'utf8')).toBe('guide');
    expect(await fs.readFile(path.join(dest, 'access.md'), 'utf8')).toBe('policy');
    // The generated paths — what the runner force-adds past a template .gitignore.
    expect(generated.sort()).toEqual(['KnowledgeBase/.gitkeep', 'Plugins/.gitkeep', 'roles.yaml']);
    expect(await exists(dest, 'roles.yaml')).toBe(true);
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

  it('throws on a file squatting the Plugins name even when no Groups/ exists', async () => {
    // Without Groups/ the step used to early-return before the squat guard —
    // silently skipping a branch whose reserved root cannot be a plugin tree
    // (and on a draft nothing later would ever report it).
    await seedUpstream({ Plugins: 'i am a file, not a folder' });
    await expect(makeRunner([new GroupsToPluginsStep()]).runAll()).rejects.toThrow(
      /"Plugins" exists but is not a directory/,
    );
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

/**
 * Migration edge cases ported from the deleted in-place module's suite
 * (plugins-migration.test.ts) — same assertions, new trigger: the step runs
 * through the real runner and the tree under test is a fresh checkout of what
 * it committed. Refusals now surface through the step's `partial` outcome,
 * which the runner logs via console.warn.
 */
describe('GroupsToPluginsStep — migration edge cases', () => {
  async function migrate(): Promise<void> {
    await makeRunner([new GroupsToPluginsStep()]).runAll();
  }

  async function readJson(dir: string, rel: string): Promise<Record<string, any>> {
    return JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));
  }

  /** What the runner's `partial` warning carried — the named refusals. */
  function partialReason(warn: { mock: { calls: unknown[][] } }): string {
    return warn.mock.calls
      .flat()
      .map(String)
      .filter((line) => line.includes('groups-to-plugins: partial'))
      .join(' ');
  }

  it('merges into an existing mcp.json without clobbering what is already there', async () => {
    await seedUpstream({
      'Groups/GTM/access.md': 'write:\n  - Admin\n',
      'Groups/GTM/notion.tool': JSON.stringify(
        { name: 'notion', type: 'mcp', url: 'https://mcp.notion.com/mcp' },
        null,
        2,
      ),
      'Groups/GTM/mcp.json': JSON.stringify({
        mcpServers: { notion: { type: 'streamable-http', url: 'https://hand.example/mcp' } },
      }),
    });
    await migrate();
    const dir = await checkout(DEFAULT_BRANCH);
    const mcp = await readJson(dir, 'Plugins/GTM/mcp.json');
    // The hand-written notion entry WINS; the converted .tool is gone either way.
    expect(mcp.mcpServers.notion.url).toBe('https://hand.example/mcp');
    expect(await exists(dir, 'Plugins/GTM/notion.tool')).toBe(false);
  });

  it('refuses to convert an mcp .tool whose url is not directly parseable http(s)', async () => {
    // A templated url (`${VENDOR_BASE}/mcp`) is legal in a `.tool`, where the
    // substitutor expands it — but the mcp.json loader validates `new URL`
    // and skips the entry, so converting would delete the source and write a
    // dead entry: the integration would simply vanish.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedUpstream({
      'Groups/GTM/access.md': 'write:\n  - Admin\n',
      'Groups/GTM/vendor.tool': JSON.stringify({ name: 'vendor', type: 'mcp', url: '${VENDOR_BASE}/mcp' }),
      'Groups/GTM/socket.tool': JSON.stringify({ name: 'socket', type: 'mcp', url: 'wss://mcp.vendor.example/mcp' }),
    });
    await migrate();
    const dir = await checkout(DEFAULT_BRANCH);
    // Both stay `.tool` files (moved with the other unconvertibles), and no
    // mcp.json is invented for them.
    expect(await exists(dir, 'Plugins/GTM/software.bevel.hexis/tools/vendor.tool')).toBe(true);
    expect(await exists(dir, 'Plugins/GTM/software.bevel.hexis/tools/socket.tool')).toBe(true);
    expect(await exists(dir, 'Plugins/GTM/mcp.json')).toBe(false);
    // The refusal is NAMED in the partial reason — an operator must be able to
    // tell a deliberately-retained integration from one that silently failed.
    // (socket.tool never reaches the named refusals: its wss url fails
    // `.tool` normalization itself, the not-a-candidate path.)
    expect(partialReason(warn)).toMatch(/vendor\.tool NOT converted — its url is not directly parseable/);
  });

  it('refuses to convert an mcp .tool whose url carries userinfo', async () => {
    // `https://user:pass@…` copied into mcp.json would put a credential in
    // the PORTABLE file — the exact thing the header split exists to prevent
    // — and stripping it would break the server. The manual keeps its
    // `.tool` form, where the credential stays platform-internal.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedUpstream({
      'Groups/GTM/access.md': 'write:\n  - Admin\n',
      'Groups/GTM/vendor.tool': JSON.stringify(
        { name: 'vendor', type: 'mcp', url: 'https://user:pass@mcp.vendor.example/mcp' },
      ),
    });
    await migrate();
    const dir = await checkout(DEFAULT_BRANCH);
    expect(await exists(dir, 'Plugins/GTM/software.bevel.hexis/tools/vendor.tool')).toBe(true);
    expect(await exists(dir, 'Plugins/GTM/mcp.json')).toBe(false);
    expect(partialReason(warn)).toMatch(/vendor\.tool NOT converted — its url embeds credentials/);
  });

  it('refuses to convert an mcp .tool that gates itself with frontmatter access verbs', async () => {
    // The access resolver reads a `.tool`'s own verbs from the file itself;
    // an mcp.json entry has no per-server home for them, so converting would
    // silently widen who may configure and run the server.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedUpstream({
      'Groups/GTM/access.md': 'write:\n  - Admin\n',
      'Groups/GTM/gated.tool':
        '---\nname: gated\ntype: mcp\nurl: https://mcp.vendor.example/mcp\nwrite:\n  - Product Team\n---\n',
    });
    await migrate();
    const dir = await checkout(DEFAULT_BRANCH);
    expect(await exists(dir, 'Plugins/GTM/software.bevel.hexis/tools/gated.tool')).toBe(true);
    expect(await exists(dir, 'Plugins/GTM/mcp.json')).toBe(false);
    // The verbs travel with the file — the moved copy still declares them.
    expect(
      await fs.readFile(path.join(dir, 'Plugins/GTM/software.bevel.hexis/tools/gated.tool'), 'utf8'),
    ).toContain('Product Team');
    expect(partialReason(warn)).toMatch(/gated\.tool NOT converted — it gates itself with frontmatter access verbs/);
  });

  it('refuses to convert an mcp .tool whose id is not a valid mcp.json server name', async () => {
    // The mcp.json loader accepts only names it can serve as a namespace and
    // route slug — converting would DELETE a working integration and write an
    // entry discovery then skips.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedUpstream({
      'Groups/GTM/access.md': 'write:\n  - Admin\n',
      'Groups/GTM/vendor.tool': JSON.stringify(
        { name: 'MyVendor', type: 'mcp', url: 'https://mcp.vendor.example/mcp' },
      ),
    });
    await migrate();
    const dir = await checkout(DEFAULT_BRANCH);
    expect(await exists(dir, 'Plugins/GTM/software.bevel.hexis/tools/vendor.tool')).toBe(true);
    expect(await exists(dir, 'Plugins/GTM/mcp.json')).toBe(false);
    expect(partialReason(warn)).toMatch(/vendor\.tool NOT converted — its id "MyVendor" is not a valid mcp\.json server name/);
  });

  it('splits headers: literals into mcp.json, credential references into plugin.json extensions', async () => {
    await seedUpstream({
      'Groups/GTM/access.md': 'write:\n  - Admin\n',
      'Groups/GTM/vendor.tool': JSON.stringify({
        name: 'vendor',
        type: 'mcp',
        url: 'https://mcp.vendor.example/mcp',
        headers: { Authorization: 'Bearer ${VENDOR_KEY}', 'X-Api-Version': '2' },
      }),
    });
    await migrate();
    const dir = await checkout(DEFAULT_BRANCH);
    const mcp = await readJson(dir, 'Plugins/GTM/mcp.json');
    // The spec forbids credentials in `headers` and forbids expanding anything
    // but ${PLUGIN_ROOT}/${PLUGIN_DATA} — a copied ${VENDOR_KEY} would be sent
    // literally by a conformant client.
    expect(mcp.mcpServers.vendor.headers).toEqual({ 'X-Api-Version': '2' });
    // The reference lives on in the extensions block, which is ours to interpret.
    const manifest = await readJson(dir, 'Plugins/GTM/plugin.json');
    expect(manifest.extensions['software.bevel.hexis'].mcpServers.vendor.headers).toEqual({
      Authorization: 'Bearer ${VENDOR_KEY}',
    });
    expect(await exists(dir, 'Plugins/GTM/software.bevel.hexis/tools/vendor.tool')).toBe(false);
  });

  it('routes anything the substitutor would expand to the extensions block — non-name ${…} stays literal', async () => {
    await seedUpstream({
      'Groups/GTM/access.md': 'write:\n  - Admin\n',
      'Groups/GTM/vendor.tool': JSON.stringify({
        name: 'vendor',
        type: 'mcp',
        url: 'https://mcp.vendor.example/mcp',
        // The substitutor's grammar decides: bare `$VENDOR_KEY` and the
        // digit-leading `$5` in the price BOTH expand, so both route to the
        // non-portable half; `${not-a-name}` is not expandable and stays.
        headers: {
          Authorization: 'Bearer $VENDOR_KEY',
          'X-Price': '$5 per call',
          'X-Tag': 'v ${not-a-name}',
        },
      }),
    });
    await migrate();
    const dir = await checkout(DEFAULT_BRANCH);
    const mcp = await readJson(dir, 'Plugins/GTM/mcp.json');
    expect(mcp.mcpServers.vendor.headers).toEqual({ 'X-Tag': 'v ${not-a-name}' });
    const manifest = await readJson(dir, 'Plugins/GTM/plugin.json');
    expect(manifest.extensions['software.bevel.hexis'].mcpServers.vendor.headers).toEqual({
      Authorization: 'Bearer $VENDOR_KEY',
      'X-Price': '$5 per call',
    });
  });

  it('leaves a personal folder a valid plugin', async () => {
    await seedUpstream({
      'Groups/personal-u-123/access.md': 'write:\n  - Ali <ali@x.com>\n',
    });
    await migrate();
    const dir = await checkout(DEFAULT_BRANCH);
    const manifest = await readJson(dir, 'Plugins/personal-u-123/plugin.json');
    expect(manifest.name).toMatch(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  });

  describe('the .bevelignore root rule', () => {
    it('follows the rename, preserving every other line', async () => {
      await seedUpstream({
        'Groups/GTM/access.md': 'write:\n  - Admin\n',
        '.bevelignore': '# mine\nGroups/\nMy-Own-Rule/\n',
      });
      await migrate();
      const dir = await checkout(DEFAULT_BRANCH);
      const ignore = norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'));
      expect(ignore.split('\n')).toContain('Plugins/');
      expect(ignore).not.toContain('Groups/');
      expect(ignore).toContain('# mine');
      expect(ignore).toContain('My-Own-Rule/');
    });

    it('rewrites EVERY exact Groups/ line — the first becomes Plugins/, duplicates are dropped', async () => {
      await seedUpstream({
        'Groups/GTM/access.md': 'write:\n  - Admin\n',
        '.bevelignore': 'Groups/\n# keep\nGroups/\n',
      });
      await migrate();
      const dir = await checkout(DEFAULT_BRANCH);
      const lines = norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8')).split('\n');
      expect(lines.filter((l) => l.trim() === 'Plugins/')).toHaveLength(1);
      expect(lines.filter((l) => l.trim() === 'Groups/')).toHaveLength(0);
      expect(lines).toContain('# keep');
    });

    it('is left alone when Plugins/ is already listed', async () => {
      await seedUpstream({
        'Groups/GTM/access.md': 'write:\n  - Admin\n',
        '.bevelignore': 'Groups/\nPlugins/\n',
      });
      await migrate();
      const dir = await checkout(DEFAULT_BRANCH);
      // The stale line is harmlessly dead; deleting it would be editing the
      // operator's file beyond what the rename made stale.
      expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe('Groups/\nPlugins/\n');
    });

    it('is not touched by a run that does not rename', async () => {
      await seedUpstream({
        'Plugins/GTM/access.md': 'write:\n  - Admin\n',
        'Plugins/GTM/outreach/SKILL.md': '# Outreach\n',
        '.bevelignore': 'Groups/\n',
      });
      await migrate();
      const dir = await checkout(DEFAULT_BRANCH);
      expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe('Groups/\n');
      // The run still reorganised the folder — the rule alone was off-limits.
      expect(await exists(dir, 'Plugins/GTM/skills/outreach/SKILL.md')).toBe(true);
    });
  });
});
