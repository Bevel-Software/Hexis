import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NodeFs } from '../../../../kb-fs/node-fs.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KbStartupRunner } from '../../kb-startup-runner.js';
import { NodeGitRunner } from '../../../../workflow/git/node-git-runner.js';
import type { OnServerStart, ServerStartContext, StepResult } from '../../on-server-start.js';
import { GroupsToPluginsStep } from '../groups-to-plugins.step.js';
import { PluginDisplayNamesStep } from '../plugin-display-names.step.js';
import { PluginManifestsStep } from '../plugin-manifests.step.js';
import { PersonalSpacesStep } from '../personal-spaces.step.js';
import { RolesYamlStep } from '../roles-yaml.step.js';
import { renderRolesYaml } from '../../../../access-model/render-roles-yaml.js';
import { mergeGroupsIntoRoles, parseRolesYaml } from '../../../../access-model/access-grammar.js';
import { TemplateFilesStep } from '../template-files.step.js';
import { buildSeedTree } from '../seed-tree.js';
import { defaultKbTemplateDir } from '../../../../../assets.js';
import {
  DEFAULT_KB_LAYOUT,
  agentsFilePointerSentence,
  configureKbLayout,
  renderKbLayoutPlaceholders,
} from '@bevel-software/platform-shared';
import { PLATFORM_HEADER, TOOL_PREFIX_LINE, composeAgentInstructions } from '../../../../agent-instructions/index.js';

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
  configureKbLayout({ ...DEFAULT_KB_LAYOUT });
  await fs.rm(root, { recursive: true, force: true });
});

/** A populated upstream carrying `files`: one commit, both protected refs. Returns the seed clone. */
async function seedUpstream(
  files: Record<string, string>,
  /** Symlinks to seed beside them: path in the repo → the target it points at. */
  symlinks: Record<string, string> = {},
): Promise<string> {
  const seed = path.join(root, '.seed');
  await fs.mkdir(seed, { recursive: true });
  await git(seed, ['init', '-b', DEFAULT_BRANCH]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(seed, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  for (const [rel, target] of Object.entries(symlinks)) {
    const abs = path.join(seed, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.symlink(target, abs);
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
    gitRunner: new NodeGitRunner(),
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

async function readJson(dir: string, rel: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));
}

const norm = (text: string) => text.replace(/\r\n?/g, '\n');
const PREAMBLE_IGNORE_BLOCK =
  '\n# Added by the platform: agent instructions are edited from External agent access.\n' +
  '/mcp-description.md\n';

/** The template as the step writes it under the default layout — placeholders rendered. */
async function template(name: string): Promise<string> {
  return renderKbLayoutPlaceholders(await fs.readFile(path.join(TEMPLATE_DIR, name), 'utf8'), DEFAULT_KB_LAYOUT);
}

/** Every required file + reserved root already present, from the real template. */
async function fullScaffold(): Promise<Record<string, string>> {
  return {
    'access.md': await template('access.md'),
    'AGENTS.md': await template('AGENTS.md'),
    '.bevelignore': await template('.bevelignore'),
    '.gitignore': await template('gitignore.template'),
    'mcp-description.md': await template('mcp-description.md'),
    'KnowledgeBase/.gitkeep': '',
    'Plugins/.gitkeep': '',
    'Skills/.gitkeep': '',
  };
}

describe('TemplateFilesStep', () => {
  it('adds the missing scaffolding — .gitignore arriving from its packable template spelling', async () => {
    await seedUpstream({ 'marker.txt': 'seeded' });
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    for (const b of PROTECTED) {
      const dir = await checkout(b);
      for (const rel of ['access.md', 'AGENTS.md', '.bevelignore', '.gitignore', 'mcp-description.md']) {
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
      expect(await exists(dir, 'Skills/.gitkeep')).toBe(true);
      const subject = (await git(dir, ['log', '--format=%s', '-1'])).trim();
      expect(subject).toMatch(/^Add missing KB scaffolding: /);
      expect(subject).toContain('.gitignore');
    }
  });

  it('renders the managed files with the deployment\'s own root names', async () => {
    // A deployment that renamed its roots must hand the agent a guide naming
    // the folders it will find, and an ignore file hiding the real ones.
    configureKbLayout({ knowledgeBaseDir: 'docs', skillsDir: 'skills', pluginsDir: 'plugins' });
    await seedUpstream({ 'marker.txt': 'seeded' });
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    const agents = norm(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'));
    expect(agents).toContain('plugins/<Plugin>/plugin.json');
    expect(agents).toContain('`docs/`');
    expect(agents).not.toContain('{{');
    expect(agents).not.toContain('KnowledgeBase/');
    const ignore = norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8')).split('\n').map((l) => l.trim());
    // Both roots stay VISIBLE, whatever they are called: the Skills & Tools
    // sidebar reads each from the workspace tree.
    expect(ignore).not.toContain('plugins/');
    expect(ignore).not.toContain('skills/');
    expect(ignore).not.toContain('Plugins/');
    expect(ignore).toContain('roles.yaml');
    expect(await exists(dir, 'docs/.gitkeep')).toBe(true);

    // And a second boot sees the rendered guide as current: no churn commit.
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();
    const again = await checkout(DEFAULT_BRANCH);
    expect((await git(again, ['rev-list', '--count', 'HEAD'])).trim()).toBe('2'); // init + scaffolding
  });

  /**
   * The placement rule. A tester's agent filed a ticket into a plugin folder
   * and explained itself: it had found no convention saying where tickets go,
   * and Plugins was where it already held write rights. The guide named the
   * three roots but never said which KIND of file belongs in which — so the
   * section has to survive into the guide agents actually read, which is this
   * written file (an MCP session reads the branch's copy of it), under the
   * deployment's own root names rather than the placeholders.
   */
  it('writes the "Where a new file goes" placement rule, named for the deployment\'s roots', async () => {
    configureKbLayout({ knowledgeBaseDir: 'Docs', skillsDir: 'Abilities', pluginsDir: 'Extensions' });
    await seedUpstream({ 'marker.txt': 'seeded' });
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    const agents = norm(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'));
    const start = agents.indexOf('## Where a new file goes\n');
    expect(start, 'the written guide has no placement section').toBeGreaterThan(-1);
    // The section alone, so a phrase matched elsewhere in the guide cannot
    // stand in for a rule that is missing here.
    const section = agents.slice(start).split('\n## ')[0]!;

    // A document goes to the knowledge root, a shared skill to the skills
    // root or the plugin's own skills folder, machinery inside a plugin.
    expect(section).toContain('`Docs/`');
    expect(section).toContain('`Abilities/`');
    expect(section).toContain('Extensions/<Plugin>/skills/<skill>/SKILL.md');
    expect(section).toContain('Extensions/<Plugin>/software.bevel.hexis/tools/');
    for (const kind of ['notes', 'reports', 'tickets', 'mcp.json', 'plugin.json']) {
      expect(section, kind).toContain(kind);
    }
    // And the two rules the tester's agent broke.
    expect(section).toMatch(/never holds a document/);
    expect(section).toMatch(/\bask\b/);

    // Rendered, not raw: a leftover placeholder would name a folder that is
    // not there in a section whose whole job is naming the right folder.
    expect(section).not.toContain('{{');
    expect(section).not.toContain('KnowledgeBase/');
  });

  /**
   * The step is built at boot, while the process still runs the defaults; the
   * save that completes first-run setup applies the admin's names afterwards.
   * A root list snapshotted at construction scaffolded `Skills/` beside the
   * `skills/` they had just chosen — the very bug the names exist to avoid.
   */
  it('scaffolds the layout in effect when it RUNS, not the one it was built under', async () => {
    const builtAtBoot = new TemplateFilesStep(new NodeFs());
    await seedUpstream({ 'skills/deploy/SKILL.md': '# deploy\n' });
    configureKbLayout({ knowledgeBaseDir: 'Docs', skillsDir: 'skills', pluginsDir: 'Plugins' });
    await makeRunner([builtAtBoot]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    // Listed rather than probed: a probe for `Skills` answers yes on a
    // case-insensitive filesystem that holds `skills`.
    const roots = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name !== '.git')
      .map((e) => e.name)
      .sort();
    expect(roots).toEqual(['Docs', 'Plugins', 'skills']);
    expect(await exists(dir, 'Docs/.gitkeep')).toBe(true);
    const subject = (await git(dir, ['log', '--format=%s', '-1'])).trim();
    expect(subject).toContain('Docs/.gitkeep');
    expect(subject).not.toContain('KnowledgeBase/');
    expect(subject).not.toContain('Skills/');
  });

  it('replaces a drifted AGENTS.md, and says so when that is the only change', async () => {
    await seedUpstream({ ...(await fullScaffold()), 'AGENTS.md': 'stale conventions\n' });
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'))).toBe(norm(await template('AGENTS.md')));
    const subject = (await git(dir, ['log', '--format=%s', '-1'])).trim();
    expect(subject).toBe('Update AGENTS.md to the current platform template');
  });

  it('ships the roles-vs-groups guide, and a deployment on an older template receives it at boot', async () => {
    const guide = await template('AGENTS.md');
    // The section runs from its own heading to the next heading of any level (or the end).
    const section = guide.split(/\n(?=#{1,6} )/).find((s) => s.startsWith('### Roles are pre-set')) ?? '';
    const prose = section.replace(/\s+/g, ' ');
    // What roles are, that agents never create them, the group test, what to do instead.
    expect(prose).toContain('A role in `roles.yaml` is an app role');
    expect(prose).toContain('**Agents never create roles.**');
    expect(prose).toContain('**Is it really a group?**');
    expect(prose).toContain('**What to do instead.**');
    expect(prose).toContain('add people to existing roles, and use a GROUP for a task- or team-scoped set of people');

    // An existing deployment's AGENTS.md from before the guide existed.
    await seedUpstream({ ...(await fullScaffold()), 'AGENTS.md': guide.replace(section, '') });
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'))).toContain('**Agents never create roles.**');
  });

  it('documents giving a role to a group, with a valid example, in the guide the step writes', async () => {
    const guide = await template('AGENTS.md');
    const section = guide.split(/\n(?=#{2,3} )/).find((s) => s.startsWith('### Giving a role to a group')) ?? '';
    const prose = section.replace(/\s+/g, ' ');
    expect(prose).toContain('`- group:<Name>`');
    expect(prose).toContain('case- and whitespace-insensitively against the active group source');
    expect(prose).toContain('validation error');
    expect(prose).toContain('names the entry');
    expect(prose).toContain("removes the role's contribution for everyone in the group");
    // A bare name resolves to a same-named group first, so role denials use `role/`.
    expect(prose).toContain('`deny role/Reviewer`');
    // Closeness first: a person's own entry wins only inside the same access.md.
    expect(prose).toContain('The nearest `access.md` that says anything about the person decides');
    expect(prose).toContain('in the SAME `access.md` as the denial keeps that access');
    expect(prose).toContain('A group under `Admin` makes every member a full admin');
    // A change request cannot carry a roles.yaml edit — the merge restores the
    // base file — so the guide says who changes roles and where, and never
    // walks an agent through drafting one.
    expect(prose).toContain('Only an Admin changes `roles.yaml`');
    expect(prose).toContain('A change request cannot carry the edit');
    expect(prose).toContain('Do not propose one');
    expect(prose).toContain('`edit_file`');
    for (const tool of ['create_branch', 'commit_change', 'open_change_request']) {
      expect(prose).not.toContain(`\`${tool}\``);
    }

    // The example parses as a roles.yaml whose group entry names a real group.
    const example = /```yaml\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
    expect(example).toContain('- group:Platform Team');
    const parsed = parseRolesYaml(example);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const groups = new Map([['platform team', { displayName: 'Platform Team', emails: new Set(['pat@example.com']) }]]);
    expect(mergeGroupsIntoRoles(parsed.index, groups, 'groups.yaml')).toEqual([]);
    // The example hands out an ordinary role, never Admin.
    expect(parsed.index.byEmail.get('pat@example.com')?.has('reviewer')).toBe(true);
    expect(parsed.index.byEmail.get('pat@example.com')?.has('role/admin')).toBe(false);

    // What the step writes — the file agents read through the MCP server — carries it.
    await seedUpstream({ ...(await fullScaffold()), 'AGENTS.md': guide.replace(section, '') });
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();
    const written = norm(await fs.readFile(path.join(await checkout(DEFAULT_BRANCH), 'AGENTS.md'), 'utf8'));
    expect(written).toContain('### Giving a role to a group');
    expect(written).toContain(example);
  });

  it('rejects the git folder — in any spelling — as a reserved root name', async () => {
    for (const bad of ['.git', '.GIT', '.Git', '.git.', '%2egit']) {
      expect(() => new TemplateFilesStep(new NodeFs(), [bad]), bad).toThrow(/must not name the git folder/);
    }
  });

  it('appends the managed root-file rules to a custom template that lacks them', async () => {
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

    await makeRunner([new TemplateFilesStep(new NodeFs())], customTemplate).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    const lines = norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8')).split('\n').map((l) => l.trim());
    expect(lines).toContain('MyStuff/'); // the operator's rules survive
    expect(lines).toContain('AGENTS.md'); // the platform's rule was appended
    expect(lines).toContain('/mcp-description.md');
    expect(lines).not.toContain('Skills/'); // never the skills root — the Library's tree needs it
  });

  it('drops the Skills/ rule an earlier release appended, and its comment, keeping every other rule', async () => {
    // A knowledge base whose ignore file was topped up by the release that
    // hid the skills root: the platform's comment + line sit at the end. The
    // Skills & Tools sidebar reads that root from the workspace tree now, so
    // the rule comes out exactly as it went in — nothing of the operator's moves.
    const scaffold = await fullScaffold();
    scaffold['.bevelignore'] =
      '# mine\n.git/\nAGENTS.md\nPlugins/\n\n# Added by the platform: the conventions doc is not node content.\nSkills/\n';
    await seedUpstream(scaffold);

    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    const text = norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'));
    // The plugins-root rule goes with it — the same sidebar draws that root now.
    expect(text).toBe('# mine\n.git/\nAGENTS.md\n' + PREAMBLE_IGNORE_BLOCK);
    // Idempotent: a second boot has nothing to change.
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();
    const again = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(again, '.bevelignore'), 'utf8'))).toBe(text);
  });

  it("drops the template's own Skills/ rule from a KB seeded by that release, comment included — whatever root the comment named", async () => {
    // The previous template listed the rule under its own explanatory line,
    // ending with the plugins root's name of the day; a deployment may have
    // renamed that root since, so the line is known by its opening.
    const scaffold = await fullScaffold();
    scaffold['.bevelignore'] =
      'AGENTS.md\nPlugins/\n# The shared-skills root is rendered by the Skills & Tools app, like Groups/.\nSkills/\n';
    await seedUpstream(scaffold);

    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe(
      'AGENTS.md\n' + PREAMBLE_IGNORE_BLOCK,
    );
  });

  it('recognises the legacy comment for a renamed plugins root with a space in its name', async () => {
    // The name between the fixed opening and closing is judged by the one
    // root-name rule the platform has, so every name it could have rendered
    // there is recognised — and nothing a root cannot be called is.
    const scaffold = await fullScaffold();
    scaffold['.bevelignore'] =
      'AGENTS.md\nPlugins/\n# The shared-skills root is rendered by the Skills & Tools app, like My Plugins/.\nSkills/\n';
    await seedUpstream(scaffold);

    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe(
      'AGENTS.md\n' + PREAMBLE_IGNORE_BLOCK,
    );
  });

  it("keeps an operator's Skills/ rule whose own comment merely opens like the platform's", async () => {
    // Provenance is the platform's EXACT comment. A comment that begins the
    // same way and goes on differently was never written by the platform.
    const scaffold = await fullScaffold();
    const text =
      'AGENTS.md\n# The shared-skills root is rendered by the Skills & Tools app, and I hide it anyway\nSkills/\n';
    scaffold['.bevelignore'] = text;
    await seedUpstream(scaffold);

    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe(
      text + PREAMBLE_IGNORE_BLOCK,
    );
  });

  it("keeps a Skills/ rule the operator wrote themselves — provenance is the platform's comment", async () => {
    const scaffold = await fullScaffold();
    scaffold['.bevelignore'] = 'AGENTS.md\n# I hide skills on purpose\nSkills/\n';
    await seedUpstream(scaffold);

    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe(
      'AGENTS.md\n# I hide skills on purpose\nSkills/\n' + PREAMBLE_IGNORE_BLOCK,
    );
  });

  it('drops EVERY Plugins/ rule, whoever wrote it — the sidebar draws that root now, and the seed left no comment to know it by', async () => {
    // The first template ever seeded hid the plugins root as a bare line at
    // the end of the file, so provenance cannot tell the platform's copy
    // from an operator's; both would empty the Plugins tree, and both go.
    // One under the platform's own comment loses the comment with it; a
    // `!Plugins/` negation is not the rule and stays.
    const scaffold = await fullScaffold();
    scaffold['.bevelignore'] =
      '# mine\nAGENTS.md\nPlugins/\nMy-Own-Rule/\n# Added by the platform: the conventions doc is not node content.\nPlugins/\n!Plugins/\n';
    await seedUpstream(scaffold);

    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    const text = norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'));
    expect(text).toBe('# mine\nAGENTS.md\nMy-Own-Rule/\n!Plugins/\n' + PREAMBLE_IGNORE_BLOCK);
    // Idempotent: a second boot has nothing to change.
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();
    const again = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(again, '.bevelignore'), 'utf8'))).toBe(text);
  });

  it("declares a custom template's ignore file without the Plugins/ rule it still ships", async () => {
    // A distribution's own template may still carry the rule the packaged
    // one dropped; a KB seeded from it must not start out hiding the root.
    const customTemplate = path.join(root, 'custom-template-plugins-rule');
    await fs.cp(TEMPLATE_DIR, customTemplate, { recursive: true });
    await fs.writeFile(path.join(customTemplate, '.bevelignore'), '.git/\nAGENTS.md\n\nPlugins/\n');
    await seedUpstream({ 'marker.txt': 'seeded' });

    await makeRunner([new TemplateFilesStep(new NodeFs())], customTemplate).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    const lines = norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8')).split('\n').map((l) => l.trim());
    expect(lines).not.toContain('Plugins/');
    expect(lines).toContain('AGENTS.md');
  });

  it('never seeds a template entry that links into a git folder', async () => {
    // A template that IS a working tree (this repo in a Docker build) can hold
    // a link into its own .git. The name rule cannot see it; the target can.
    const customTemplate = path.join(root, 'custom-template-gitlink');
    await fs.cp(TEMPLATE_DIR, customTemplate, { recursive: true });
    await fs.mkdir(path.join(customTemplate, '.git'), { recursive: true });
    await fs.writeFile(path.join(customTemplate, '.git', 'config'), '[credential]\n\thelper = store\n');
    await fs.symlink(path.join('.git', 'config'), path.join(customTemplate, 'notes.md'));

    const dir = path.join(root, 'seeded-gitlink');
    await fs.mkdir(dir, { recursive: true });
    await buildSeedTree(new NodeFs(), customTemplate, [], ['admin@example.com'])(dir);

    await expect(fs.readFile(path.join(dir, 'notes.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readdir(path.join(dir, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The rest of the template still seeded.
    expect(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('#');
  });

  it('seeds a binary template file byte for byte and keeps a script executable — text is what decodes', async () => {
    const customTemplate = path.join(root, 'custom-template-bytes');
    // The packaged template as a base, plus two files it does not ship.
    await fs.cp(TEMPLATE_DIR, customTemplate, { recursive: true });
    await fs.mkdir(path.join(customTemplate, 'assets'), { recursive: true });
    await fs.mkdir(path.join(customTemplate, 'scripts'), { recursive: true });
    // Not UTF-8, and holding a NUL: text by no reading of the bytes. A
    // name-based rule once sent this through the decoder and changed it.
    const binary = Buffer.from([0x89, 0x50, 0x00, 0xff, 0xfe, 0x7b, 0x7b, 0x7d, 0x7d]);
    await fs.writeFile(path.join(customTemplate, 'assets', '.logo.bin'), binary);
    await fs.writeFile(path.join(customTemplate, 'scripts', 'run.sh'), '#!/bin/sh\necho {{skillsDir}}\n', { mode: 0o755 });
    // The empty-remote seed is the one path that copies a whole template.
    const dir = path.join(root, 'seeded-bytes');
    await fs.mkdir(dir, { recursive: true });
    await buildSeedTree(new NodeFs(),customTemplate, [], ['admin@example.com'])(dir);

    expect(await fs.readFile(path.join(dir, 'assets', '.logo.bin'))).toEqual(binary);
    expect(norm(await fs.readFile(path.join(dir, 'scripts', 'run.sh'), 'utf8'))).toBe('#!/bin/sh\necho Skills\n');
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(dir, 'scripts', 'run.sh'))).mode & 0o111).not.toBe(0);
    }
  });

  it("declares a custom template's ignore file without the stale Skills/ rule it still ships", async () => {
    // A KB with NO ignore file gets the template's copy — and a distribution's
    // template may still carry the rule the previous release had. The on-disk
    // reconciliation never runs on an absent file, so the declared content
    // must arrive already reconciled.
    const customTemplate = path.join(root, 'custom-template-stale');
    await fs.mkdir(customTemplate, { recursive: true });
    await fs.writeFile(path.join(customTemplate, 'AGENTS.md'), await template('AGENTS.md'), 'utf8');
    await fs.writeFile(
      path.join(customTemplate, '.bevelignore'),
      '# custom\nMyStuff/\n# The shared-skills root is rendered by the Skills & Tools app, like {{pluginsDir}}/.\n{{skillsDir}}/\n',
      'utf8',
    );
    const scaffold = await fullScaffold();
    delete scaffold['.bevelignore'];
    await seedUpstream(scaffold);

    await makeRunner([new TemplateFilesStep(new NodeFs())], customTemplate).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    const text = norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'));
    expect(text).toContain('MyStuff/');
    expect(text.split('\n').map((l) => l.trim())).not.toContain('Skills/');
    expect(text).not.toContain('shared-skills root');
  });

  it("leaves an operator's !Skills/ negation alone — there is nothing of the platform's to remove", async () => {
    const scaffold = await fullScaffold();
    scaffold['.bevelignore'] = 'AGENTS.md\n!Skills/\n';
    await seedUpstream(scaffold);

    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe(
      'AGENTS.md\n!Skills/\n' + PREAMBLE_IGNORE_BLOCK,
    );
  });

  it('respects an explicit !AGENTS.md negation — hiding the doc is a default, not a mandate', async () => {
    // Appending the positive rule after the negation would WIN under ordered
    // matching and silently defeat the operator's stated choice to show it.
    const scaffold = await fullScaffold();
    scaffold['.bevelignore'] = '# operator wants the doc visible\n!AGENTS.md\nMyStuff/\n';
    await seedUpstream(scaffold);

    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe(
      '# operator wants the doc visible\n!AGENTS.md\nMyStuff/\n' + PREAMBLE_IGNORE_BLOCK,
    );
  });

  it('respects an explicit !mcp-description.md negation', async () => {
    const scaffold = await fullScaffold();
    scaffold['.bevelignore'] = 'AGENTS.md\n!mcp-description.md\n';
    await seedUpstream(scaffold);

    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe(
      'AGENTS.md\n!mcp-description.md\n',
    );
  });

  it("respells the platform's OWN unanchored preamble rule instead of leaving it standing", async () => {
    // What the release that shipped the unanchored spelling wrote. The bare
    // name hides a nested `mcp-description.md` page too, so the platform's own
    // line is corrected rather than treated as somebody's choice.
    const scaffold = await fullScaffold();
    scaffold['.bevelignore'] =
      'AGENTS.md\n# Added by the platform: agent instructions are edited from External agent access.\nmcp-description.md\n';
    await seedUpstream(scaffold);

    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe(
      'AGENTS.md\n# Added by the platform: agent instructions are edited from External agent access.\n/mcp-description.md\n',
    );
    // Idempotent: a second boot has nothing to change.
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();
    const again = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(again, '.bevelignore'), 'utf8'))).toBe(
      'AGENTS.md\n# Added by the platform: agent instructions are edited from External agent access.\n/mcp-description.md\n',
    );
  });

  it("keeps an unanchored preamble rule the operator wrote themselves, and adds nothing beside it", async () => {
    const scaffold = await fullScaffold();
    scaffold['.bevelignore'] = 'AGENTS.md\n# I hide it everywhere on purpose\nmcp-description.md\n';
    await seedUpstream(scaffold);

    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe(
      'AGENTS.md\n# I hide it everywhere on purpose\nmcp-description.md\n',
    );
  });

  it('seeds mcp-description.md on every protected branch, from the template, when it is missing', async () => {
    const scaffold = await fullScaffold();
    delete scaffold['mcp-description.md'];
    await seedUpstream(scaffold);
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    for (const b of PROTECTED) {
      const dir = await checkout(b);
      expect(norm(await fs.readFile(path.join(dir, 'mcp-description.md'), 'utf8'))).toBe(
        norm(await template('mcp-description.md')),
      );
      const subject = (await git(dir, ['log', '--format=%s', '-1'])).trim();
      expect(subject).toBe('Add missing KB scaffolding: mcp-description.md');
    }
  });

  it('leaves an existing mcp-description.md untouched: seeded once, never refreshed', async () => {
    const mine = 'Acme builds solar farms.\n\n## What is where\n\n- Projects/\n';
    await seedUpstream({ ...(await fullScaffold()), 'mcp-description.md': mine });
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, 'mcp-description.md'), 'utf8'))).toBe(mine);
    expect((await git(dir, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1'); // init only
  });

  it('keeps a deliberately emptied mcp-description.md empty: the top-up restores only a MISSING file', async () => {
    await seedUpstream({ ...(await fullScaffold()), 'mcp-description.md': '' });
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(await fs.readFile(path.join(dir, 'mcp-description.md'), 'utf8')).toBe('');
    expect((await git(dir, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
  });

  it('ships a template that composes to the platform header alone: one comment, nothing broadcast', async () => {
    const shipped = await template('mcp-description.md');
    expect(shipped.trimStart().startsWith('<!--')).toBe(true);
    expect(shipped.trimEnd().endsWith('-->')).toBe(true);
    // The first line says how to turn the text on; the caps are stated inside.
    expect(shipped.split('\n')[0]).toMatch(/Remove this comment wrapper/);
    expect(shipped).toContain('6,000 characters');
    expect(shipped).toContain('first paragraph under about 220');
    expect(shipped).not.toContain('{{');
    const composed = composeAgentInstructions(shipped);
    expect(composed.instructions).toBe(PLATFORM_HEADER);
    expect(composed.toolPrefix).toBe(TOOL_PREFIX_LINE);
    expect(composed.unterminatedComment).toBe(false);
    expect(composed.preambleChars).toBe(0);
  });

  it('seeds mcp-description.md from the packaged template when a custom template predates it, instead of failing the boot', async () => {
    // A distribution's own KB_TEMPLATE_DIR forked before this file existed:
    // the upgrade must not stop startup over a file whose content is one
    // comment. The packaged copy stands in, and the log says so once.
    const customTemplate = path.join(root, 'custom-template-old');
    await fs.mkdir(customTemplate, { recursive: true });
    await fs.writeFile(path.join(customTemplate, 'AGENTS.md'), await template('AGENTS.md'), 'utf8');
    await fs.writeFile(path.join(customTemplate, 'access.md'), await template('access.md'), 'utf8');
    const scaffold = await fullScaffold();
    delete scaffold['mcp-description.md'];
    await seedUpstream(scaffold);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await makeRunner([new TemplateFilesStep(new NodeFs())], customTemplate).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(norm(await fs.readFile(path.join(dir, 'mcp-description.md'), 'utf8'))).toBe(
      norm(await template('mcp-description.md')),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no "mcp-description.md"'));
  });

  it('gives the stand-in to that file only: a custom template missing access.md still fails loudly', async () => {
    const stricter = path.join(root, 'custom-template-broken');
    await fs.mkdir(stricter, { recursive: true });
    await fs.writeFile(path.join(stricter, 'AGENTS.md'), await template('AGENTS.md'), 'utf8');
    const scaffold = await fullScaffold();
    delete scaffold['access.md'];
    await seedUpstream(scaffold);
    await expect(makeRunner([new TemplateFilesStep(new NodeFs())], stricter).runAll()).rejects.toThrow(/ENOENT/);
  });

  it('points a clone at mcp-description.md from the managed AGENTS.md, before the platform mechanics', async () => {
    const agents = await template('AGENTS.md');
    const pointer = agents.indexOf('mcp-description.md');
    expect(pointer).toBeGreaterThan(-1);
    expect(pointer).toBeLessThan(agents.indexOf('## Directory Structure'));
    expect(agents).toMatch(/default branch's copy inline/);
  });

  it('treats a CRLF checkout of identical AGENTS.md content as current — no churn commit', async () => {
    const scaffold = await fullScaffold();
    scaffold['AGENTS.md'] = norm(scaffold['AGENTS.md']!).replace(/\n/g, '\r\n');
    await seedUpstream(scaffold);
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect((await git(dir, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1'); // init only
  });

  /**
   * The guide under a name of the deployment's own — and what becomes of the
   * `AGENTS.md` beside it, which on such a deployment is the CUSTOMER'S file.
   */
  describe('a renamed agent guide', () => {
    /** The scaffold minus the guide, so each test says for itself what `AGENTS.md` holds. */
    async function scaffoldWithoutGuide(): Promise<Record<string, string>> {
      const scaffold = await fullScaffold();
      delete scaffold['AGENTS.md'];
      return scaffold;
    }

    const CUSTOMER_GUIDE = '# Acme conventions\n\nWrite tickets in the present tense.\n';

    it('writes and refreshes the guide under the configured name, on every protected branch', async () => {
      configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
      await seedUpstream({ 'marker.txt': 'seeded' });
      await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

      for (const branch of PROTECTED) {
        const dir = await checkout(branch);
        const guide = norm(await fs.readFile(path.join(dir, 'HEXIS.md'), 'utf8'));
        // The header names the file it lives in, not the name it ships under.
        expect(guide).toContain('`HEXIS.md`');
        expect(guide).not.toContain('{{');
        expect(await exists(dir, 'AGENTS.md')).toBe(false);
      }

      // A second boot sees the rendered guide as current: no churn commit…
      await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();
      expect((await git(await checkout(DEFAULT_BRANCH), ['rev-list', '--count', 'HEAD'])).trim()).toBe('2');

      // …and a drifted copy is replaced, exactly as `AGENTS.md` is by default.
      const dir = await checkout(DEFAULT_BRANCH);
      await fs.writeFile(path.join(dir, 'HEXIS.md'), 'stale conventions\n', 'utf8');
      await git(dir, ['commit', '-am', 'drift']);
      await git(dir, ['push', 'origin', DEFAULT_BRANCH]);
      await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();
      const after = await checkout(DEFAULT_BRANCH);
      expect(norm(await fs.readFile(path.join(after, 'HEXIS.md'), 'utf8'))).toContain('# Knowledge base');
      expect((await git(after, ['log', '--format=%s', '-1'])).trim()).toBe(
        'Update HEXIS.md to the current platform template',
      );
    });

    it('leaves a customer AGENTS.md byte for byte alone, and shows it in the tree', async () => {
      configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
      // Their file already names the guide, so the pointer has nothing to add
      // — this test is about the bytes and the ignore rules alone.
      const theirs = `${CUSTOMER_GUIDE}\nSee HEXIS.md for the platform.\n`;
      await seedUpstream({ ...(await scaffoldWithoutGuide()), 'AGENTS.md': theirs });
      await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

      const dir = await checkout(DEFAULT_BRANCH);
      expect(norm(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'))).toBe(theirs);
      expect(await exists(dir, 'HEXIS.md')).toBe(true);
      const ignore = norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))
        .split('\n')
        .map((l) => l.trim());
      // The configured file is hidden; the customer's shows.
      expect(ignore).toContain('HEXIS.md');
      expect(ignore).not.toContain('AGENTS.md');
    });

    it('removes the platform-written AGENTS.md — only its own header proves it ours', async () => {
      // A knowledge base the platform seeded, whose admin then renames the guide.
      await seedUpstream({ 'marker.txt': 'seeded' });
      await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();
      expect(await exists(await checkout(DEFAULT_BRANCH), 'AGENTS.md')).toBe(true);

      configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
      await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

      // On EVERY protected branch: the step tops up each one, and a rename
      // that only reached the default branch would leave the others carrying a
      // stale platform guide under the customer's name.
      for (const branch of PROTECTED) {
        const dir = await checkout(branch);
        expect(await exists(dir, 'AGENTS.md'), branch).toBe(false);
        expect(await exists(dir, 'HEXIS.md'), branch).toBe(true);
        const message = await git(dir, ['log', '--format=%B', '-1']);
        expect(message, branch).toContain(
          'Remove the platform-written AGENTS.md — the agent guide is now HEXIS.md',
        );
      }
    });

    it('keeps an AGENTS.md it cannot prove it wrote, and says so', async () => {
      configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
      // Edited by the customer: the managed header is gone, so it is theirs.
      const edited = `${CUSTOMER_GUIDE}\nMentions HEXIS.md already.\n`;
      await seedUpstream({ ...(await scaffoldWithoutGuide()), 'AGENTS.md': edited });
      await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

      for (const branch of PROTECTED) {
        const dir = await checkout(branch);
        expect(norm(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')), branch).toBe(edited);
        expect(await git(dir, ['log', '--format=%B', '-1']), branch).toContain('Keep AGENTS.md');
      }
    });

    it('leaves a root AGENTS.md that is a symbolic link exactly where it points', async () => {
      // Following the link would read the managed header at the other end and
      // delete the customer's entry — or, with the pointer on, write our
      // sentence into a file nobody asked us to edit.
      configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
      await seedUpstream({ ...(await scaffoldWithoutGuide()), 'conventions/ours.md': await template('AGENTS.md') });
      // Committed as a link, so every checkout the step makes carries one.
      const seeding = await checkout(DEFAULT_BRANCH);
      await fs.symlink('conventions/ours.md', path.join(seeding, 'AGENTS.md'));
      await git(seeding, ['add', '-A']);
      await git(seeding, ['commit', '-m', 'link AGENTS.md at our own file']);
      await git(seeding, ['push', 'origin', DEFAULT_BRANCH]);

      await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

      const dir = await checkout(DEFAULT_BRANCH);
      expect((await fs.lstat(path.join(dir, 'AGENTS.md'))).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(path.join(dir, 'AGENTS.md'))).toBe('conventions/ours.md');
      // The file at the other end is untouched — neither removed nor appended to.
      expect(norm(await fs.readFile(path.join(dir, 'conventions/ours.md'), 'utf8'))).toBe(
        norm(await template('AGENTS.md')),
      );
    });

    it("keeps an operator's own AGENTS.md ignore rule while dropping the platform's", async () => {
      configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
      const scaffold = await scaffoldWithoutGuide();
      // Their own rule, written by hand, nowhere near the template's slot.
      scaffold['.bevelignore'] = '# mine\nAGENTS.md\nMyStuff/\n';
      scaffold['AGENTS.md'] = `${CUSTOMER_GUIDE}\nSee HEXIS.md.\n`;
      await seedUpstream(scaffold);
      await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

      const text = norm(
        await fs.readFile(path.join(await checkout(DEFAULT_BRANCH), '.bevelignore'), 'utf8'),
      );
      expect(text).toContain('# mine\nAGENTS.md\nMyStuff/');
      expect(text.split('\n').map((l) => l.trim())).toContain('HEXIS.md');
    });

    it("keeps an operator's rule that merely happens to sit under .gitattributes", async () => {
      configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
      const scaffold = await scaffoldWithoutGuide();
      // Hand-written, and by coincidence in the position the template's own
      // rule used to occupy. One matching line above is not provenance — the
      // block the template wrote is not there, so the rule is theirs.
      scaffold['.bevelignore'] = '# ours\n.gitattributes\nAGENTS.md\nMyStuff/\n';
      scaffold['AGENTS.md'] = `${CUSTOMER_GUIDE}\nSee HEXIS.md.\n`;
      await seedUpstream(scaffold);
      await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

      const text = norm(
        await fs.readFile(path.join(await checkout(DEFAULT_BRANCH), '.bevelignore'), 'utf8'),
      );
      expect(text).toContain('# ours\n.gitattributes\nAGENTS.md\nMyStuff/');
      expect(text.split('\n').map((l) => l.trim())).toContain('HEXIS.md');
    });

    it("drops the bare rule an earlier release seeded in the template's hygiene block", async () => {
      configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
      const scaffold = await scaffoldWithoutGuide();
      // The `.bevelignore` of a knowledge base seeded before the rule had a
      // comment above it: bare, at the end of the template's own block.
      scaffold['.bevelignore'] =
        '# Repo hygiene files that clutter the tree without being node content.\n' +
        '.gitignore\n.gitattributes\nAGENTS.md\nroles.yaml\n';
      scaffold['AGENTS.md'] = `${CUSTOMER_GUIDE}\nSee HEXIS.md.\n`;
      await seedUpstream(scaffold);
      await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

      const lines = norm(
        await fs.readFile(path.join(await checkout(DEFAULT_BRANCH), '.bevelignore'), 'utf8'),
      )
        .split('\n')
        .map((l) => l.trim());
      // The platform's line goes; the block above it is content and stays.
      expect(lines).not.toContain('AGENTS.md');
      expect(lines).toContain('.gitattributes');
      expect(lines).toContain('.gitignore');
      expect(lines).toContain('HEXIS.md');
    });

    describe('the pointer in the customer\'s own AGENTS.md', () => {
      /** Boot once with the guide renamed, against a root `AGENTS.md` holding `theirs`. */
      async function bootWith(theirs: string | null, link = true): Promise<string> {
        configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
        const scaffold = await scaffoldWithoutGuide();
        if (theirs !== null) scaffold['AGENTS.md'] = theirs;
        await seedUpstream(scaffold);
        await makeRunner([new TemplateFilesStep(new NodeFs(), [], () => link)]).runAll();
        return checkout(DEFAULT_BRANCH);
      }

      const SENTENCE = agentsFilePointerSentence('HEXIS.md');

      it('appends the sentence when the guide is not mentioned, and says so', async () => {
        const dir = await bootWith(CUSTOMER_GUIDE);
        const text = norm(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'));
        // Their bytes, then a blank line, then exactly the shared sentence.
        expect(text).toBe(`${CUSTOMER_GUIDE.replace(/\n+$/, '')}\n\n${SENTENCE}\n`);
        expect(await git(dir, ['log', '--format=%B', '-1'])).toContain(
          'Add a pointer to HEXIS.md at the end of AGENTS.md',
        );
      });

      /**
       * The sentence spells a punctuated name twice and neither spelling is
       * the raw one — the label is escaped, the destination percent-encoded.
       * A second boot must still see the guide as mentioned, or it appends
       * another copy, and the boot after that a third.
       */
      it('appends once and only once, even when the name is nothing but punctuation', async () => {
        const guide = 'Our [Agent] Guide (v2).md';
        configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: guide });
        await seedUpstream({ ...(await scaffoldWithoutGuide()), 'AGENTS.md': CUSTOMER_GUIDE });
        const boot = () => makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

        await boot();
        const once = norm(await fs.readFile(path.join(await checkout(DEFAULT_BRANCH), 'AGENTS.md'), 'utf8'));
        expect(once).toBe(
          `${CUSTOMER_GUIDE.replace(/\n+$/, '')}\n\n${agentsFilePointerSentence(guide)}\n`,
        );

        const head = (await git(await checkout(DEFAULT_BRANCH), ['rev-parse', 'HEAD'])).trim();
        await boot();
        const after = await checkout(DEFAULT_BRANCH);
        expect(norm(await fs.readFile(path.join(after, 'AGENTS.md'), 'utf8'))).toBe(once);
        // And the second boot committed nothing at all.
        expect((await git(after, ['rev-parse', 'HEAD'])).trim()).toBe(head);
      });

      /**
       * The guide's name is a setting, and a setting can be changed twice. The
       * sentence the last rename wrote points at a file that is no longer
       * there, and the new name is nowhere in the text — so "is it mentioned?"
       * says no and an unaimed sentence would be joined by a second one.
       */
      it('aims the sentence it already wrote at the new guide, rather than adding another', async () => {
        configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
        await seedUpstream({ ...(await scaffoldWithoutGuide()), 'AGENTS.md': CUSTOMER_GUIDE });
        await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();
        expect(norm(await fs.readFile(path.join(await checkout(DEFAULT_BRANCH), 'AGENTS.md'), 'utf8'))).toContain(
          agentsFilePointerSentence('HEXIS.md'),
        );

        // The admin renames the guide a second time.
        configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'GUIDE.md' });
        await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();

        const dir = await checkout(DEFAULT_BRANCH);
        const text = norm(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'));
        // Their bytes, then ONE sentence, pointing at the guide that exists.
        expect(text).toBe(
          `${CUSTOMER_GUIDE.replace(/\n+$/, '')}\n\n${agentsFilePointerSentence('GUIDE.md')}\n`,
        );
        expect(text).not.toContain('HEXIS.md');
        expect(await git(dir, ['log', '--format=%B', '-1'])).toContain(
          'Point the sentence in AGENTS.md at GUIDE.md',
        );
      });

      it('writes nothing when the name appears anywhere in the text, in any wording', async () => {
        const theirs = `${CUSTOMER_GUIDE}\nThe platform keeps its own notes in HEXIS.md; read those too.\n`;
        const dir = await bootWith(theirs);
        expect(norm(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'))).toBe(theirs);
      });

      it('writes nothing while the setting is off', async () => {
        const dir = await bootWith(CUSTOMER_GUIDE, false);
        expect(norm(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'))).toBe(CUSTOMER_GUIDE);
      });

      it('never creates an AGENTS.md for the pointer', async () => {
        const dir = await bootWith(null);
        expect(await exists(dir, 'AGENTS.md')).toBe(false);
        expect(await exists(dir, 'HEXIS.md')).toBe(true);
      });

      it('never appends to a file the platform wrote — it removes that one instead', async () => {
        const dir = await bootWith(await template('AGENTS.md'));
        expect(await exists(dir, 'AGENTS.md')).toBe(false);
      });

      it('does nothing at all under the default name', async () => {
        const theirs = `${CUSTOMER_GUIDE}`;
        // The default guide IS AGENTS.md, so the platform owns that file and
        // the pointer question never arises: the drifted copy is replaced.
        await seedUpstream({ ...(await fullScaffold()), 'AGENTS.md': theirs });
        await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();
        const dir = await checkout(DEFAULT_BRANCH);
        const text = norm(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'));
        expect(text).toBe(norm(await template('AGENTS.md')));
        expect(text).not.toContain(agentsFilePointerSentence('AGENTS.md'));
      });
    });
  });
});

describe('RolesYamlStep', () => {
  it('generates roles.yaml with the configured admins on every protected branch', async () => {
    await seedUpstream({ 'marker.txt': 'seeded' });
    await makeRunner([new RolesYamlStep(new NodeFs(), ['admin@example.com'])]).runAll();

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
    await expect(makeRunner([new RolesYamlStep(new NodeFs(), ['admin@example.com'])]).runAll()).rejects.toThrow(
      /"roles\.yaml" on branch "current-company-state" exists but is not a regular file \(directory\)/,
    );
  });

  it('declares a skip when the file is missing and no admins are configured', async () => {
    await seedUpstream({ 'marker.txt': 'seeded' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await makeRunner([new RolesYamlStep(new NodeFs(), [])]).runAll(); // resolves — a declared skip, not a failure

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
    const generated = await buildSeedTree(new NodeFs(),templateDir, [], ['admin@example.com'])(dest);

    expect(await exists(dest, '.git')).toBe(false);
    expect(await exists(dest, 'docs/.git')).toBe(false);
    expect(await fs.readFile(path.join(dest, 'docs/guide.md'), 'utf8')).toBe('guide');
    expect(await fs.readFile(path.join(dest, 'access.md'), 'utf8')).toBe('policy');
    // The generated paths — what the runner force-adds past a template .gitignore.
    expect(generated.sort()).toEqual(['KnowledgeBase/.gitkeep', 'Plugins/.gitkeep', 'Skills/.gitkeep', 'roles.yaml']);
    expect(await exists(dest, 'roles.yaml')).toBe(true);
  });

  it('seeds the layout in effect when it seeds, not the one it was composed under', async () => {
    const templateDir = path.join(root, 'seed-template-layout');
    await fs.mkdir(templateDir, { recursive: true });
    await fs.writeFile(path.join(templateDir, 'access.md'), 'policy', 'utf8');
    // Composed at boot, under the defaults…
    const seed = buildSeedTree(new NodeFs(), templateDir, [], ['admin@example.com']);
    // …and run after the completing save applied the admin's names.
    configureKbLayout({ knowledgeBaseDir: 'Docs', skillsDir: 'skills', pluginsDir: 'Plugins' });
    const dest = path.join(root, 'seed-dest-layout');
    await fs.mkdir(dest, { recursive: true });
    const generated = await seed(dest);
    expect(generated.sort()).toEqual(['Docs/.gitkeep', 'Plugins/.gitkeep', 'roles.yaml', 'skills/.gitkeep']);
  });

  /**
   * An empty remote seeded by a deployment that renamed its guide. Done in the
   * SEED rather than left to the top-up step, which would otherwise lay down
   * `AGENTS.md` and delete it one commit later — two commits saying opposite
   * things about a knowledge base nobody has used yet.
   */
  it('seeds the packaged guide under the configured name, and no AGENTS.md beside it', async () => {
    configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    const dest = path.join(root, 'seed-dest-guide');
    await fs.mkdir(dest, { recursive: true });
    await buildSeedTree(new NodeFs(), TEMPLATE_DIR, [], ['admin@example.com'])(dest);
    expect(await exists(dest, 'AGENTS.md')).toBe(false);
    const guide = norm(await fs.readFile(path.join(dest, 'HEXIS.md'), 'utf8'));
    expect(guide).toContain('`HEXIS.md`');
    expect(guide).not.toContain('{{');
    // And the ignore file hides the name it actually seeded.
    const ignore = norm(await fs.readFile(path.join(dest, '.bevelignore'), 'utf8'))
      .split('\n')
      .map((l) => l.trim());
    expect(ignore).toContain('HEXIS.md');
    expect(ignore).not.toContain('AGENTS.md');
  });

  it('lets the managed guide win a template that carries a root file of the same name', async () => {
    // A custom KB_TEMPLATE_DIR that happens to ship `HEXIS.md` at its root, on
    // a deployment that named its guide `HEXIS.md`: two walk entries, one
    // destination. Whichever the walk reached last used to decide what an
    // empty deployment was seeded with. The managed guide decides.
    const customTemplate = path.join(root, 'custom-template-guide-clash');
    await fs.cp(TEMPLATE_DIR, customTemplate, { recursive: true });
    await fs.writeFile(path.join(customTemplate, 'HEXIS.md'), '# Not the platform guide\n', 'utf8');

    configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    const dest = path.join(root, 'seed-dest-guide-clash');
    await fs.mkdir(dest, { recursive: true });
    await buildSeedTree(new NodeFs(), customTemplate, [], ['admin@example.com'])(dest);

    const guide = norm(await fs.readFile(path.join(dest, 'HEXIS.md'), 'utf8'));
    expect(guide).toContain('`HEXIS.md`');
    expect(guide).not.toContain('Not the platform guide');
    expect(await exists(dest, 'AGENTS.md')).toBe(false);
  });

  it('names a template that is not there — a missing directory is a broken build, not an empty seed', async () => {
    const dest = path.join(root, 'seed-dest-missing');
    await fs.mkdir(dest, { recursive: true });
    await expect(buildSeedTree(new NodeFs(),path.join(root, 'no-such-template'), [], ['admin@example.com'])(dest)).rejects.toThrow(
      /KB template ".*no-such-template" is not a directory/,
    );
  });

  it('seeds a file the template links to, and refuses a link to anything else', async () => {
    const templateDir = path.join(root, 'seed-template-links');
    const elsewhere = path.join(root, 'elsewhere-template');
    await fs.mkdir(path.join(templateDir, 'docs'), { recursive: true });
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.writeFile(path.join(elsewhere, 'shared.md'), 'shared', 'utf8');
    await fs.writeFile(path.join(templateDir, 'access.md'), 'policy', 'utf8');
    await fs.symlink(path.join(elsewhere, 'shared.md'), path.join(templateDir, 'docs', 'linked.md'), 'file');

    const dest = path.join(root, 'seed-dest-links');
    await fs.mkdir(dest, { recursive: true });
    await buildSeedTree(new NodeFs(),templateDir, [], ['admin@example.com'])(dest);
    // The link's CONTENT, under the link's own name, as a real file.
    expect(await fs.readFile(path.join(dest, 'docs/linked.md'), 'utf8')).toBe('shared');
    expect((await fs.lstat(path.join(dest, 'docs/linked.md'))).isSymbolicLink()).toBe(false);

    // A link to nothing is a broken template, named as such…
    await fs.symlink(path.join(root, 'nowhere.md'), path.join(templateDir, 'dangling.md'), 'file');
    const dest2 = path.join(root, 'seed-dest-links-2');
    await fs.mkdir(dest2, { recursive: true });
    await expect(buildSeedTree(new NodeFs(),templateDir, [], ['admin@example.com'])(dest2)).rejects.toThrow(
      /KB template entry "dangling.md" links to nothing/,
    );
    // …and so is a link to a folder, named for what it is.
    await fs.rm(path.join(templateDir, 'dangling.md'));
    await fs.symlink(elsewhere, path.join(templateDir, 'dirlink'), process.platform === 'win32' ? 'junction' : 'dir');
    const dest3 = path.join(root, 'seed-dest-links-3');
    await fs.mkdir(dest3, { recursive: true });
    await expect(buildSeedTree(new NodeFs(),templateDir, [], ['admin@example.com'])(dest3)).rejects.toThrow(
      /KB template entry "dirlink" links to a directory/,
    );
  });

  it('seeds a template file whose name collides with Object.prototype', async () => {
    // The packable-spelling lookup is keyed by FILENAME. Asked about a file
    // called `constructor` an object map answers from the prototype and hands
    // a function to path.join, failing the seed of a whole knowledge base
    // with a type error that names nothing.
    const templateDir = path.join(root, 'proto-template');
    await fs.mkdir(templateDir, { recursive: true });
    await fs.writeFile(path.join(templateDir, 'access.md'), 'policy', 'utf8');
    await fs.writeFile(path.join(templateDir, 'constructor'), 'not a function', 'utf8');
    await fs.writeFile(path.join(templateDir, 'toString'), 'nor this', 'utf8');

    const dest = path.join(root, 'proto-dest');
    await fs.mkdir(dest, { recursive: true });
    await buildSeedTree(new NodeFs(), templateDir, [], ['admin@example.com'])(dest);
    expect(await fs.readFile(path.join(dest, 'constructor'), 'utf8')).toBe('not a function');
    expect(await fs.readFile(path.join(dest, 'toString'), 'utf8')).toBe('nor this');
  });
});

describe('PluginManifestsStep', () => {
  it('writes plugin.json into legacy plugin folders on every branch, and leaves scopes and real plugins alone', async () => {
    const scaffold = await fullScaffold();
    await seedUpstream({
      ...scaffold,
      // Legacy shapes: access.md only; mcp.json only; a bare skill tree.
      'Plugins/GTM/access.md': '---\n---\nread:\n  - everyone\n',
      'Plugins/GTM/outreach/SKILL.md': '---\ndescription: x\n---\n',
      'Plugins/Servers/mcp.json': '{"mcpServers":{}}',
      'Plugins/Bare/deploy/SKILL.md': '---\ndescription: y\n---\n',
      // Already a plugin, both shapes.
      'Plugins/Modern/plugin.json': '{"name":"modern"}',
      'Plugins/functional/cluster/example/plugin.bundle.json': '{"name":"example"}',
      // A scope with rules of its own above a bundle: not a plugin.
      'Plugins/functional/access.md': '---\n---\nread:\n  - everyone\n',
      // Nothing plugin-shaped at all.
      'Plugins/notes/README.md': 'just a folder',
      // A legacy plugin whose vendored dependency ships a manifest: the walk
      // does not enter node_modules, so the folder is the plugin, not a
      // grouping folder over one.
      'Plugins/Vendored/access.md': '---\n---\nread:\n  - everyone\n',
      'Plugins/Vendored/node_modules/some-pkg/plugin.json': '{"name":"some-pkg"}',
      // A plain folder whose only SKILL.md is vendored: not a plugin either.
      'Plugins/deps/node_modules/some-pkg/SKILL.md': '---\ndescription: z\n---\n',
    });

    await makeRunner([new PluginManifestsStep(new NodeFs())]).runAll();

    for (const branch of PROTECTED) {
      const dir = await checkout(branch);
      for (const legacy of ['GTM', 'Servers', 'Bare', 'Vendored']) {
        const manifest = JSON.parse(await fs.readFile(path.join(dir, `Plugins/${legacy}/plugin.json`), 'utf8'));
        expect(manifest.name).toBe(legacy.toLowerCase());
      }
      expect(await exists(dir, 'Plugins/functional/plugin.json')).toBe(false);
      expect(await exists(dir, 'Plugins/notes/plugin.json')).toBe(false);
      expect(await exists(dir, 'Plugins/deps/plugin.json')).toBe(false);
      expect(await fs.readFile(path.join(dir, 'Plugins/Modern/plugin.json'), 'utf8')).toBe('{"name":"modern"}');
    }
    const dir = await checkout(DEFAULT_BRANCH);
    const log = (await git(dir, ['log', '-1', '--format=%B'])).trim();
    expect(log).toContain('Add plugin manifests to 4 legacy plugin folders');
    expect(log).toContain('Plugins/GTM: plugin.json written');

    // Idempotent: nothing left to write on the next boot.
    await makeRunner([new PluginManifestsStep(new NodeFs())]).runAll();
    const again = await checkout(DEFAULT_BRANCH);
    expect((await git(again, ['rev-list', '--count', 'HEAD'])).trim()).toBe('2'); // init + one migration commit
  });
});

describe('PluginDisplayNamesStep', () => {
  /**
   * The one-time repair behind the display-name rule: a manifest is now the
   * only thing any reader consults for what a plugin is called, so every
   * manifest written under the old rule — which stored the field only when
   * the folder was spelled differently from the identifier — has to be told
   * what its plugin was already called, or it would appear to rename itself
   * on the boot that introduces the rule.
   */
  it('writes the folder\'s spelling into the manifests that lack the field, and touches nothing else', async () => {
    const scaffold = await fullScaffold();
    await seedUpstream({
      ...scaffold,
      // Spelled differently from its identifier and saying nothing about it:
      // exactly the plugin that would start showing `sales-team`.
      'Plugins/Sales Team/plugin.json': '{\n  "name": "sales-team",\n  "version": "1.2.0"\n}\n',
      'Plugins/Sales Team/access.md': '---\n---\nread:\n  - everyone\n',
      // Nested just as deep as discovery looks.
      'Plugins/Teams/EU Field/plugin.json': '{"name":"eu-field"}',
      // Already spelled as its identifier: called the same thing under both
      // rules, so there is nothing the folder knows that the manifest does not.
      'Plugins/imported-tools/plugin.json': '{"name":"imported-tools"}',
      // Already carries the field — the author's own answer, never overwritten,
      // even though the folder disagrees with both of its names.
      'Plugins/Ops Desk/plugin.json': '{"name":"ops","displayName":"Operations"}',
      // A bundle: a foreign repository's file this platform reads, never writes.
      'Plugins/functional/cluster/example/plugin.bundle.json': '{"name":"example"}',
    });

    await makeRunner([new PluginDisplayNamesStep(new NodeFs())]).runAll();

    for (const branch of PROTECTED) {
      const dir = await checkout(branch);
      // Backfilled from the folder — what the plugin was called the moment
      // before the boot — with everything else in the manifest kept, and the
      // field where the renderer puts it.
      const sales = await readJson(dir, 'Plugins/Sales Team/plugin.json');
      expect(sales).toEqual({ name: 'sales-team', displayName: 'Sales Team', version: '1.2.0' });
      expect(Object.keys(sales)).toEqual(['name', 'displayName', 'version']);
      expect(await readJson(dir, 'Plugins/Teams/EU Field/plugin.json')).toEqual({
        name: 'eu-field',
        displayName: 'EU Field',
      });
      // Untouched, byte for byte.
      expect(await fs.readFile(path.join(dir, 'Plugins/imported-tools/plugin.json'), 'utf8')).toBe(
        '{"name":"imported-tools"}',
      );
      expect(await fs.readFile(path.join(dir, 'Plugins/Ops Desk/plugin.json'), 'utf8')).toBe(
        '{"name":"ops","displayName":"Operations"}',
      );
      expect(await fs.readFile(path.join(dir, 'Plugins/functional/cluster/example/plugin.bundle.json'), 'utf8')).toBe(
        '{"name":"example"}',
      );
    }

    const dir = await checkout(DEFAULT_BRANCH);
    const log = (await git(dir, ['log', '-1', '--format=%B'])).trim();
    expect(log).toContain('Record the display names of 2 plugins in their manifests');
    expect(log).toContain('Plugins/Sales Team: displayName "Sales Team"');

    // Idempotent: every manifest it would touch now carries the field.
    await makeRunner([new PluginDisplayNamesStep(new NodeFs())]).runAll();
    const again = await checkout(DEFAULT_BRANCH);
    expect((await git(again, ['rev-list', '--count', 'HEAD'])).trim()).toBe('2'); // init + one backfill commit
  });

  /**
   * The three shapes the plain "lacks the field, folder differs" reading gets
   * wrong: a field that is present and says nothing, a manifest naming the
   * folder's own spelling without being an identifier, and a `plugin.json`
   * that is not this platform's file to write.
   */
  it('repairs a blank field, leaves a manifest that already shows its folder, and never writes through a link', async () => {
    const scaffold = await fullScaffold();
    await seedUpstream(
      {
        ...scaffold,
        // Present but BLANK. The new reader falls through it to `name` where
        // the old one fell through to the folder, so leaving it be is leaving
        // the rename this step exists to prevent: blank is absent, and repaired.
        'Plugins/Growth Team/plugin.json': '{"name":"growth-team","displayName":"   "}',
        // A `name` that is no identifier but IS the folder's spelling: the
        // identity is the slug `my-plugin`, and what people see is already
        // "My Plugin". The folder knows nothing the manifest does not.
        'Plugins/My Plugin/plugin.json': '{"name":"My Plugin"}',
        // An own `__proto__` key — `JSON.parse` makes it one. Copied as DATA:
        // assignment would have set the object's prototype instead, dropping
        // the field and letting a prototype `displayName` stand in for the
        // one being written.
        'Plugins/Odd One/plugin.json': '{"name":"odd-one","__proto__":{"displayName":"from the prototype"}}',
        // A bundle makes this folder a plugin; the `plugin.json` beside it is
        // a LINK, which discovery does not count as a native manifest.
        'Plugins/Kit Pro/plugin.bundle.json': '{"name":"kit"}',
        'vendor-manifest.json': '{"name":"kit"}',
      },
      { 'Plugins/Kit Pro/plugin.json': '../../vendor-manifest.json' },
    );

    await makeRunner([new PluginDisplayNamesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(await readJson(dir, 'Plugins/Growth Team/plugin.json')).toEqual({
      name: 'growth-team',
      displayName: 'Growth Team',
    });
    // Untouched, byte for byte.
    expect(await fs.readFile(path.join(dir, 'Plugins/My Plugin/plugin.json'), 'utf8')).toBe('{"name":"My Plugin"}');
    expect(await fs.readFile(path.join(dir, 'Plugins/Odd One/plugin.json'), 'utf8')).toBe(
      '{\n  "name": "odd-one",\n  "displayName": "Odd One",\n  "__proto__": {\n    "displayName": "from the prototype"\n  }\n}\n',
    );
    // Still a link, and the file it points at is still the vendor's own.
    expect((await fs.lstat(path.join(dir, 'Plugins/Kit Pro/plugin.json'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(dir, 'vendor-manifest.json'), 'utf8')).toBe('{"name":"kit"}');

    const log = (await git(dir, ['log', '-1', '--format=%B'])).trim();
    expect(log).toContain('Record the display names of 2 plugins in their manifests');
    expect(log).toContain('Plugins/Growth Team: displayName "Growth Team"');
    expect(log).not.toContain('Kit Pro');

    // Idempotent over all of it: the next boot finds nothing to write.
    await makeRunner([new PluginDisplayNamesStep(new NodeFs())]).runAll();
    const again = await checkout(DEFAULT_BRANCH);
    expect((await git(again, ['rev-list', '--count', 'HEAD'])).trim()).toBe('2'); // init + one backfill commit
  });

  it('leaves a plugin the manifests step just made alone — that manifest already says it', async () => {
    const scaffold = await fullScaffold();
    await seedUpstream({
      ...scaffold,
      // Legacy: no manifest at all. The manifests step renders one, which the
      // renderer has already given both names; the backfill then finds nothing.
      'Plugins/Sales Team/access.md': '---\n---\nread:\n  - everyone\n',
    });

    await makeRunner([new PluginManifestsStep(new NodeFs()), new PluginDisplayNamesStep(new NodeFs())]).runAll();

    const dir = await checkout(DEFAULT_BRANCH);
    expect(await readJson(dir, 'Plugins/Sales Team/plugin.json')).toEqual({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'sales-team',
      displayName: 'Sales Team',
    });
    // ONE commit — the backfill declared nothing of its own to caption.
    const log = (await git(dir, ['log', '-1', '--format=%B'])).trim();
    expect(log).toContain('Add plugin manifests to a legacy plugin folder');
    expect(log).not.toContain('Record the display name');
  });
});

describe('PersonalSpacesStep', () => {
  // A personal folder as the previous template seeded it: the owner's grants
  // and nothing else — private only while nothing above grants read.
  const LEGACY_PERSONAL =
    '---\nread:\n  - Ali Vega <ali@x.io>\nwrite:\n  - Ali Vega <ali@x.io>\nowner:\n  - Ali Vega <ali@x.io>\n---\nread: []\n';

  it("adds `deny everyone` to every personal space's read rules on every branch, keeping the rest, once", async () => {
    const scaffold = await fullScaffold();
    const seed = await seedUpstream({
      ...scaffold,
      'Plugins/personal-u1/plugin.json': '{"name":"personal-u1"}',
      'Plugins/personal-u1/access.md': LEGACY_PERSONAL,
      // A space someone already closed (its folder rules stay; only the
      // file's own block, which said nothing, gets the same statement), one
      // its owner opened on purpose (a denial beside that grant would be
      // overruled and read as a contradiction — and the file stays open
      // with the folder), and a shared plugin: untouched.
      'Plugins/personal-u2/access.md': '---\nread: []\n---\nread:\n  - deny everyone\n  - Bo <bo@x.io>\n',
      'Plugins/personal-u3/access.md': '---\nread: []\n---\nread:\n  - everyone\nowner:\n  - Cy <cy@x.io>\n',
      // Entries that say nothing about READ — a denial under write — leave the
      // space open to an inherited `read: everyone`, so it is closed like any
      // other.
      'Plugins/personal-u4/access.md': '---\nread: []\n---\nwrite:\n  - deny everyone\nowner:\n  - Di <di@x.io>\n',
      // The old seed's frontmatter grants are carried into the body ONLY where
      // the body has no word on that person: a denial someone wrote there
      // stands, and is not overridden by the older grant.
      'Plugins/personal-u5/access.md': '---\nread:\n  - Ed <ed@x.io>\nowner:\n  - Ed <ed@x.io>\n---\nread:\n  - deny Ed <ed@x.io>\n',
      // A folder whose read denial is overruled by `write: everyone` (a
      // same-scope grant wins, and write folds into read) is OPEN: the file
      // stays open with it, and nothing is written.
      'Plugins/personal-u6/access.md': '---\nread: []\n---\nread:\n  - deny everyone\nwrite:\n  - everyone\nowner:\n  - Fy <fy@x.io>\n',
      // `download: everyone` is a deliberate opening now that download folds
      // into read: the space is already settled OPEN, so nothing is written —
      // the same treatment `write: everyone` gets above.
      'Plugins/personal-u7/access.md': '---\nread: []\n---\ndownload:\n  - everyone\nowner:\n  - Gi <gi@x.io>\n',
      'Plugins/GTM/plugin.json': '{"name":"gtm"}',
      'Plugins/GTM/access.md': '---\nread:\n  - everyone\n---\nread:\n  - Ali Vega <ali@x.io>\n',
    });
    // A draft carrying a personal space too: the step visits every branch,
    // not only the protected ones.
    await git(seed, ['checkout', '-b', 'ali/draft']);
    await git(seed, ['push', 'origin', 'ali/draft']);

    await makeRunner([new PersonalSpacesStep(new NodeFs())]).runAll();

    for (const branch of [...PROTECTED, 'ali/draft']) {
      const dir = await checkout(branch);
      const closed = norm(await fs.readFile(path.join(dir, 'Plugins/personal-u1/access.md'), 'utf8'));
      // The body — which governs the folder — now denies everyone (Admin
      // included: nobody is named) and carries the owner's grants so they
      // can still read, write and own their space; the old seed's
      // frontmatter grants stay, joined by the same denial, so the file says
      // of itself what the folder says.
      expect(closed).toBe(
        '---\nread:\n  - Ali Vega <ali@x.io>\n  - deny everyone\nwrite:\n  - Ali Vega <ali@x.io>\nowner:\n  - Ali Vega <ali@x.io>\n---\n' +
          'read:\n  - Ali Vega <ali@x.io>\n  - deny everyone\n\nwrite:\n  - Ali Vega <ali@x.io>\nowner:\n  - Ali Vega <ali@x.io>',
      );
      // Already closed: the folder rules are untouched, the empty file block
      // now states the same — the denial, then the people the folder admits.
      expect(norm(await fs.readFile(path.join(dir, 'Plugins/personal-u2/access.md'), 'utf8'))).toBe(
        '---\nread:\n  - deny everyone\n  - Bo <bo@x.io>\n---\nread:\n  - deny everyone\n  - Bo <bo@x.io>\n',
      );
      expect(norm(await fs.readFile(path.join(dir, 'Plugins/personal-u3/access.md'), 'utf8'))).toBe(
        '---\nread: []\n---\nread:\n  - everyone\nowner:\n  - Cy <cy@x.io>\n',
      );
      const u4 = norm(await fs.readFile(path.join(dir, 'Plugins/personal-u4/access.md'), 'utf8'));
      expect(u4.slice(0, u4.indexOf('\n---\n', 4))).toBe('---\nread:\n  - deny everyone\n  - Di <di@x.io>');
      expect(u4.trimEnd().endsWith('\nread:\n  - deny everyone')).toBe(true);
      expect(u4).toContain('write:\n  - deny everyone');
      expect(u4).toContain('owner:\n  - Di <di@x.io>');
      const u5 = norm(await fs.readFile(path.join(dir, 'Plugins/personal-u5/access.md'), 'utf8'));
      const u5Body = u5.slice(u5.indexOf('\n---\n', 4) + 5);
      // Ed's read denial stands — the frontmatter's read grant is NOT carried
      // beside it — while the owner grant, which the body said nothing about, is.
      expect(u5Body.match(/read:\n((?:  - [^\n]*\n)*)/)![1]).toBe('  - deny Ed <ed@x.io>\n  - deny everyone\n');
      expect(u5Body).toMatch(/owner:\n  - Ed <ed@x.io>/);
      // The file block keeps Ed's grant as written and gains the denial.
      expect(u5.slice(0, u5.indexOf('\n---\n', 4))).toBe('---\nread:\n  - Ed <ed@x.io>\n  - deny everyone\nowner:\n  - Ed <ed@x.io>');
      expect(norm(await fs.readFile(path.join(dir, 'Plugins/personal-u6/access.md'), 'utf8'))).toBe(
        '---\nread: []\n---\nread:\n  - deny everyone\nwrite:\n  - everyone\nowner:\n  - Fy <fy@x.io>\n',
      );
      // Untouched: `download: everyone` settles read as GRANTED (download folds
      // into read), so the step reads the space as opened on purpose.
      expect(norm(await fs.readFile(path.join(dir, 'Plugins/personal-u7/access.md'), 'utf8'))).toBe(
        '---\nread: []\n---\ndownload:\n  - everyone\nowner:\n  - Gi <gi@x.io>\n',
      );
      expect(norm(await fs.readFile(path.join(dir, 'Plugins/GTM/access.md'), 'utf8'))).toBe(
        '---\nread:\n  - everyone\n---\nread:\n  - Ali Vega <ali@x.io>\n',
      );
    }
    const dir = await checkout(DEFAULT_BRANCH);
    const log = (await git(dir, ['log', '-1', '--format=%B'])).trim();
    expect(log).toContain('Keep 4 personal spaces private');
    expect(log).toContain('Plugins/personal-u1/access.md: read denies everyone');
    expect(log).toContain('Plugins/personal-u2/access.md: read denies everyone');
    expect(log).toContain('Plugins/personal-u4/access.md: read denies everyone');
    expect(log).toContain('Plugins/personal-u5/access.md: read denies everyone');

    // Idempotent: the next boot finds every space already closed.
    await makeRunner([new PersonalSpacesStep(new NodeFs())]).runAll();
    const again = await checkout(DEFAULT_BRANCH);
    expect((await git(again, ['rev-list', '--count', 'HEAD'])).trim()).toBe('2');
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

    await makeRunner([new GroupsToPluginsStep(new NodeFs())]).runAll();

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
      // The rename's companion edit: the stale ignore rule is retired — and
      // not replaced, since the plugins root is drawn by the sidebar now.
      const ignore = await fs.readFile(path.join(dir, '.bevelignore'), 'utf8');
      expect(ignore).not.toContain('Groups/');
      expect(ignore.split('\n').map((l) => l.trim())).not.toContain('Plugins/');
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
    await expect(makeRunner([new GroupsToPluginsStep(new NodeFs())]).runAll()).rejects.toThrow(
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
      new GroupsToPluginsStep(new NodeFs()),
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
    await makeRunner([new GroupsToPluginsStep(new NodeFs())]).runAll();
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

  it('leaves a plain folder under the root alone — a .gitkeep is not a plugin, and a grouping folder holding one is not either', async () => {
    await seedUpstream({
      'Plugins/GTM/access.md': 'write:\n  - Admin\n',
      // Made with "New folder" in the tree: nothing plugin-shaped in it.
      'Plugins/TestFolder/.gitkeep': '',
      // A grouping folder with a plugin INSIDE: a manifest on the folder
      // would hide the plugin beneath it from every catalog.
      'Plugins/Teams/Agent Made/plugin.json': '{"name":"agent-made"}',
      // A legacy plugin whose vendored dependency happens to ship a
      // manifest: `node_modules` is nothing to the walk, so the folder is
      // still the plugin it was.
      'Plugins/Vendored/access.md': 'write:\n  - Admin\n',
      'Plugins/Vendored/node_modules/some-pkg/plugin.json': '{"name":"some-pkg"}',
      // A folder whose ONLY plugin-shaped entry is one the walk skips. The
      // migration's own sweep never moves a dot-entry, so counting it as
      // legacy content wrote a manifest for a folder and then moved nothing
      // into it — and the manifests step, reading a walk that had already
      // dropped it, disagreed about the same folder.
      'Plugins/HiddenOnly/.hidden.tool': 'name: hidden\n',
    });
    await migrate();
    const dir = await checkout(DEFAULT_BRANCH);
    expect(await exists(dir, 'Plugins/GTM/plugin.json')).toBe(true);
    expect(await exists(dir, 'Plugins/TestFolder/plugin.json')).toBe(false);
    expect(await exists(dir, 'Plugins/Teams/plugin.json')).toBe(false);
    expect(await exists(dir, 'Plugins/Teams/Agent Made/plugin.json')).toBe(true);
    expect(await exists(dir, 'Plugins/Vendored/plugin.json')).toBe(true);
    expect(await exists(dir, 'Plugins/HiddenOnly/plugin.json')).toBe(false);
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
    it('retires the rule with the rename — nothing takes its place — preserving every other line', async () => {
      await seedUpstream({
        'Groups/GTM/access.md': 'write:\n  - Admin\n',
        '.bevelignore': '# mine\nGroups/\nMy-Own-Rule/\n',
      });
      await migrate();
      const dir = await checkout(DEFAULT_BRANCH);
      const ignore = norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'));
      expect(ignore).toBe('# mine\nMy-Own-Rule/\n');
    });

    it('drops EVERY exact Groups/ line, keeping the lines between them', async () => {
      await seedUpstream({
        'Groups/GTM/access.md': 'write:\n  - Admin\n',
        '.bevelignore': 'Groups/\n# keep\nGroups/\n',
      });
      await migrate();
      const dir = await checkout(DEFAULT_BRANCH);
      expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe('# keep\n');
    });

    it('retires a Plugins/ line beside it too — both root rules are stale for the same reason', async () => {
      await seedUpstream({
        'Groups/GTM/access.md': 'write:\n  - Admin\n',
        '.bevelignore': '# mine\nGroups/\nPlugins/\n!Plugins/\n',
      });
      await migrate();
      const dir = await checkout(DEFAULT_BRANCH);
      expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe('# mine\n!Plugins/\n');
    });

    it('retires the rules on a branch with neither root — nothing to migrate there, and the rules are as stale', async () => {
      await seedUpstream({
        'marker.txt': 'seeded',
        '.bevelignore': 'Plugins/\nGroups/\nkeep/\n',
      });
      await migrate();
      const dir = await checkout(DEFAULT_BRANCH);
      expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe('keep/\n');
      const log = (await git(dir, ['log', '-1', '--format=%B'])).trim();
      expect(log).toContain('.bevelignore: Groups/, Plugins/ dropped');
    });

    it('names the commit for what happened: a migrated branch that only lost the rules was not reorganised', async () => {
      await seedUpstream({
        'Plugins/GTM/plugin.json': '{"name":"gtm"}',
        'Plugins/GTM/access.md': 'write:\n  - Admin\n',
        '.bevelignore': 'Plugins/\n',
      });
      await migrate();
      const dir = await checkout(DEFAULT_BRANCH);
      const log = (await git(dir, ['log', '-1', '--format=%B'])).trim();
      expect(log.split('\n')[0]).toBe('Retire the stale Groups/ and Plugins/ ignore rules');
      expect(log).not.toContain('Reorganise');
    });

    it('retires the rules on a run that does not rename — a branch migrated by an earlier release, a draft included', async () => {
      // An earlier release renamed `Groups/` to `Plugins/` in the ignore file
      // of every branch it migrated; the template step retires that line on
      // the protected branches only, so this step does it wherever it goes.
      await seedUpstream({
        'Plugins/GTM/access.md': 'write:\n  - Admin\n',
        'Plugins/GTM/outreach/SKILL.md': '# Outreach\n',
        '.bevelignore': 'AGENTS.md\nPlugins/\n',
      });
      await migrate();
      const dir = await checkout(DEFAULT_BRANCH);
      expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe('AGENTS.md\n');
      expect(await exists(dir, 'Plugins/GTM/skills/outreach/SKILL.md')).toBe(true);
      // Idempotent: a second run declares nothing.
      await migrate();
      expect(norm(await fs.readFile(path.join(await checkout(DEFAULT_BRANCH), '.bevelignore'), 'utf8'))).toBe('AGENTS.md\n');
    });

    it("takes a platform comment above a stale rule with it, and the blank line that opened the block — the template step's own tidy-up, on a branch it never visits", async () => {
      await seedUpstream({
        'Plugins/GTM/access.md': 'write:\n  - Admin\n',
        '.bevelignore':
          '# mine\n.git/\n\n# Added by the platform: the conventions doc is not node content.\nPlugins/\n# The shared-skills root is rendered by the Skills & Tools app, like Groups/.\nGroups/\n',
      });
      await migrate();
      const dir = await checkout(DEFAULT_BRANCH);
      expect(norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8'))).toBe('# mine\n.git/\n');
    });

    it('fails the run when the ignore file cannot be read — a hole is not "no file"', async () => {
      // A directory where the file should be: readable as neither. Treating
      // that as absence would leave a possible `Plugins/` rule in place and
      // report the migration done.
      await seedUpstream({
        'Plugins/GTM/access.md': 'write:\n  - Admin\n',
        '.bevelignore/keep': '',
      });
      await expect(migrate()).rejects.toThrow(/EISDIR/);
    });
  });
});

/**
 * The guide's rule in `.bevelignore` is a gitignore PATTERN, and the name rules
 * admit characters gitignore reads as syntax: written bare, `#Guide.md` is a
 * comment and hides nothing. Rendered escaped, the rule names exactly the file.
 */
describe('TemplateFilesStep: a guide named with gitignore syntax', () => {
  it('escapes the name in the ignore rule it writes, and keeps it escaped on the next boot', async () => {
    configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: '#Guide[1].md' });
    await seedUpstream({ 'marker.txt': 'seeded' });
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();
    const dir = await checkout(DEFAULT_BRANCH);
    const ignore = norm(await fs.readFile(path.join(dir, '.bevelignore'), 'utf8')).split('\n').map((l) => l.trim());
    const escaped = String.raw`\#Guide\[1\].md`;
    expect(ignore).toContain(escaped);
    expect(ignore).not.toContain('#Guide[1].md');
    expect(await exists(dir, '#Guide[1].md')).toBe(true);
    // A second boot sees the escaped rule as present and adds no second line.
    await makeRunner([new TemplateFilesStep(new NodeFs())]).runAll();
    const again = norm(await fs.readFile(path.join(await checkout(DEFAULT_BRANCH), '.bevelignore'), 'utf8'));
    expect(again.split('\n').filter((l) => l.trim() === escaped)).toHaveLength(1);
  });
});
