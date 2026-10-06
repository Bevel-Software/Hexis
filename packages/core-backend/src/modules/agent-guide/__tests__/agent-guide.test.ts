import { DEFAULT_KB_LAYOUT, renderKbLayoutPlaceholders } from '@bevel-software/platform-shared';
import { describe, expect, it } from 'vitest';
import { mergeGroupsIntoRoles, parseRolesYaml } from '../../access-model/access-grammar.js';
import { sharedFileRulesSection } from '../../agent-instructions/shared-file-rules.js';
import {
  CORE_SECTION_IDS,
  PLATFORM_GUIDE_SEPARATOR,
  WORKING_WITH_FILES_SECTION_ID,
  composeAgentGuide,
  coreAgentGuideSections,
  isAgentGuidePath,
  isManagedGuide,
  withPlatformGuideAppended,
  type AgentGuideSection,
} from '../agent-guide.js';

/**
 * The guide is text the code owns, composed from sections when an agent asks
 * for it. What is pinned here: that every section is there and in order, that
 * the layout's names are rendered into it, that a distribution's hook shapes
 * it, and what the guide says on the points agents have actually got wrong.
 */

/** The section of `guide` whose heading line starts with `heading`, up to the next heading of the same or a higher level. */
function section(guide: string, heading: string): string {
  const lines = guide.split('\n');
  const at = lines.findIndex((line) => line.startsWith(heading));
  expect(at, `the guide has no "${heading}" section`).toBeGreaterThan(-1);
  const level = /^#+/.exec(heading)![0].length;
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (new RegExp(`^#{1,${level}} `).test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

describe('the guide is composed from the platform\'s sections', () => {
  it('carries every core section, in order, the shared rules computed in their place', async () => {
    const sections = await coreAgentGuideSections(DEFAULT_KB_LAYOUT);
    expect(sections.map((s) => s.id)).toEqual(CORE_SECTION_IDS);
    const rules = sections.find((s) => s.id === WORKING_WITH_FILES_SECTION_ID)!;
    expect(rules.body).toBe(sharedFileRulesSection(DEFAULT_KB_LAYOUT));
    expect(rules.literal).toBe(true);
    // Every file section begins with its heading, so the guide reads as one document.
    for (const s of sections) {
      if (s.id === 'introduction') expect(s.body.startsWith('# Knowledge base')).toBe(true);
      else expect(s.body.startsWith('## '), s.id).toBe(true);
    }
    const guide = await composeAgentGuide(DEFAULT_KB_LAYOUT);
    let at = -1;
    for (const s of sections) {
      const heading = renderKbLayoutPlaceholders(s.body.split('\n')[0]!, DEFAULT_KB_LAYOUT);
      const here = guide.indexOf(heading, at + 1);
      expect(here, `${s.id} is out of order`).toBeGreaterThan(at);
      at = here;
    }
    expect(guide.endsWith('\n')).toBe(true);
    expect(guide.endsWith('\n\n')).toBe(false);
  });

  it('renders the deployment\'s own root names and leaves no placeholder behind', async () => {
    const guide = await composeAgentGuide({ knowledgeBaseDir: 'Docs', skillsDir: 'Abilities', pluginsDir: 'Extensions' });
    expect(guide).toContain('Extensions/<Plugin>/plugin.json');
    expect(guide).toContain('`Docs/`');
    expect(guide).toContain('`Abilities/`');
    expect(guide).not.toContain('{{');
    expect(guide).not.toContain('KnowledgeBase/');
    // The shared rules are rendered once, by the code that builds them, and
    // never passed through the renderer again: a folder literally named like a
    // placeholder comes out as the folder it is.
    const odd = await composeAgentGuide({ ...DEFAULT_KB_LAYOUT, knowledgeBaseDir: '{{skillsDir}}', skillsDir: 'Playbooks' });
    expect(odd).toContain(sharedFileRulesSection({ ...DEFAULT_KB_LAYOUT, knowledgeBaseDir: '{{skillsDir}}', skillsDir: 'Playbooks' }));
  });

  it('says it is served, not written, and names the file it is read as — under the deployment\'s name for it', async () => {
    const intro = section(await composeAgentGuide(DEFAULT_KB_LAYOUT), '# Knowledge base').replace(/\n> ?/g, ' ');
    expect(intro).toContain('**This guide is served by the platform.**');
    expect(intro).toContain('`get_agent_guide` returns it');
    expect(intro).toContain('`read_file` on `AGENTS.md` at the repository root');
    expect(intro).toContain('never write this text into it');
    // The old header, which proved a file on disk was the platform's, is gone
    // from the served text — or every read would look like a stale copy.
    expect(isManagedGuide(await composeAgentGuide(DEFAULT_KB_LAYOUT))).toBe(false);
    const aliased = (await composeAgentGuide({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' })).replace(/\n> ?/g, ' ');
    expect(aliased).toContain('`read_file` on `HEXIS.md` at the repository root');
    // And points at the preamble first, before the platform mechanics.
    const guide = await composeAgentGuide(DEFAULT_KB_LAYOUT);
    expect(guide.indexOf('mcp-description.md')).toBeLessThan(guide.indexOf('## Directory Structure'));
  });

  /**
   * A distribution's hook sees the sections and returns the sections. The
   * three things it can do — append, replace by id, drop — each with its
   * placeholders rendered like core's own, and the computed section left as
   * it was built.
   */
  it('lets a distribution append, replace and drop sections by id, rendering its text like core\'s', async () => {
    const hook = (sections: readonly AgentGuideSection[]) => [
      ...sections
        .filter((s) => s.id !== 'conventions')
        .map((s) => (s.id === 'finding-things' ? { ...s, body: '## Finding things\n\nAsk the graph.\n' } : s)),
      { id: 'knowledge-graph', body: '## Knowledge graph\n\nNodes live under `{{knowledgeBaseDir}}/<Ontology>/Knowledge/`.\n' },
    ];
    const guide = await composeAgentGuide({ ...DEFAULT_KB_LAYOUT, knowledgeBaseDir: 'Docs' }, hook);
    expect(guide).not.toContain('## Conventions');
    expect(section(guide, '## Finding things')).toContain('Ask the graph.');
    expect(section(guide, '## Finding things')).not.toContain('grep');
    expect(guide.trimEnd().endsWith('Nodes live under `Docs/<Ontology>/Knowledge/`.')).toBe(true);
    expect(guide).toContain(sharedFileRulesSection({ ...DEFAULT_KB_LAYOUT, knowledgeBaseDir: 'Docs' }));
    // An async hook is awaited, and the layout it is handed is the resolved one.
    const seen: string[] = [];
    await composeAgentGuide({ knowledgeBaseDir: ' Docs ', skillsDir: 'Skills', pluginsDir: 'Plugins' }, async (sections, layout) => {
      seen.push(layout.knowledgeBaseDir, layout.agentsFile);
      return sections;
    });
    expect(seen).toEqual(['Docs', 'AGENTS.md']);
  });

  it('puts the knowledge base\'s own file first, then a separator, then the guide', () => {
    const joined = withPlatformGuideAppended('# Acme\r\n\r\nWrite tickets in the present tense.\r\n\r\n', 'THE GUIDE\n');
    expect(joined).toBe(`# Acme\n\nWrite tickets in the present tense.\n\n${PLATFORM_GUIDE_SEPARATOR}\n\nTHE GUIDE\n`);
    expect(PLATFORM_GUIDE_SEPARATOR.startsWith('---\n')).toBe(true);
  });

  it('answers at the guide\'s name in the repository root, under AGENTS.md and under a saved alias, and nowhere else', () => {
    expect(isAgentGuidePath('AGENTS.md', DEFAULT_KB_LAYOUT)).toBe(true);
    expect(isAgentGuidePath('/AGENTS.md', DEFAULT_KB_LAYOUT)).toBe(true);
    expect(isAgentGuidePath('Handbook/AGENTS.md', DEFAULT_KB_LAYOUT)).toBe(false);
    expect(isAgentGuidePath('agents.md', DEFAULT_KB_LAYOUT)).toBe(false);
    expect(isAgentGuidePath('HEXIS.md', DEFAULT_KB_LAYOUT)).toBe(false);
    const aliased = { ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' };
    expect(isAgentGuidePath('HEXIS.md', aliased)).toBe(true);
    expect(isAgentGuidePath('AGENTS.md', aliased)).toBe(true);
    expect(isAgentGuidePath('', aliased)).toBe(false);
  });

  it('recognises a copy an earlier release wrote to disk by its header, and nothing else', () => {
    expect(isManagedGuide('# Knowledge base\n\n> **This file is managed by the platform.** It lives at…\n')).toBe(true);
    expect(isManagedGuide('# Acme conventions\n\nThis file is managed by us.\n')).toBe(false);
  });
});

/**
 * What the guide says on the points agents have got wrong. Pinned on the
 * served text, so a section that is dropped or rewritten fails here rather
 * than in a deployment.
 */
describe('what the guide tells an agent', () => {
  /**
   * The placement rule. A tester's agent filed a ticket into a plugin folder
   * and explained itself: it had found no convention saying where tickets go,
   * and Plugins was where it already held write rights.
   */
  it('says where a new file goes, named for the deployment\'s roots', async () => {
    const guide = await composeAgentGuide({ knowledgeBaseDir: 'Docs', skillsDir: 'Abilities', pluginsDir: 'Extensions' });
    const placement = section(guide, '## Where a new file goes');
    expect(placement).toContain('`Docs/`');
    expect(placement).toContain('`Abilities/`');
    expect(placement).toContain('Extensions/<Plugin>/skills/<skill>/SKILL.md');
    expect(placement).toContain('Extensions/<Plugin>/software.bevel.hexis/tools/');
    for (const kind of ['notes', 'reports', 'tickets', 'mcp.json', 'plugin.json']) {
      expect(placement, kind).toContain(kind);
    }
    expect(placement).toMatch(/never holds a document/);
    expect(placement).toMatch(/\bask\b/);
  });

  it('says that roles are pre-set and a "new role" is usually a group', async () => {
    const prose = section(await composeAgentGuide(DEFAULT_KB_LAYOUT), '### Roles are pre-set').replace(/\s+/g, ' ');
    expect(prose).toContain('A role in `roles.yaml` is an app role');
    expect(prose).toContain('**Agents never create roles.**');
    expect(prose).toContain('**Is it really a group?**');
    expect(prose).toContain('**What to do instead.**');
    expect(prose).toContain('add people to existing roles, and use a GROUP for a task- or team-scoped set of people');
  });

  it('documents giving a role to a group, with an example that parses as a valid roles.yaml', async () => {
    const text = section(await composeAgentGuide(DEFAULT_KB_LAYOUT), '### Giving a role to a group');
    const prose = text.replace(/\s+/g, ' ');
    expect(prose).toContain('`- group:<Name>`');
    expect(prose).toContain('case- and whitespace-insensitively against the active group source');
    expect(prose).toContain('validation error');
    expect(prose).toContain("removes the role's contribution for everyone in the group");
    expect(prose).toContain('`deny role/Reviewer`');
    expect(prose).toContain('A group under `Admin` makes every member a full admin');
    // A change request cannot carry a roles.yaml edit, so the guide says who
    // changes roles and where, and never walks an agent through drafting one.
    expect(prose).toContain('Only an Admin changes `roles.yaml`');
    expect(prose).toContain('Do not propose one');
    for (const tool of ['create_branch', 'commit_change', 'open_change_request']) {
      expect(prose).not.toContain(`\`${tool}\``);
    }
    const example = /```yaml\n([\s\S]*?)```/.exec(text)?.[1] ?? '';
    expect(example).toContain('- group:Platform Team');
    const parsed = parseRolesYaml(example);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const groups = new Map([['platform team', { displayName: 'Platform Team', emails: new Set(['pat@example.com']) }]]);
    expect(mergeGroupsIntoRoles(parsed.index, groups, 'groups.yaml')).toEqual([]);
    expect(parsed.index.byEmail.get('pat@example.com')?.has('reviewer')).toBe(true);
    expect(parsed.index.byEmail.get('pat@example.com')?.has('role/admin')).toBe(false);
  });
});
