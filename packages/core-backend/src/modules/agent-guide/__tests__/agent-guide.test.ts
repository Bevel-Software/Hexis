import { DEFAULT_KB_LAYOUT, renderKbLayoutPlaceholders } from '@bevel-software/platform-shared';
import { describe, expect, it } from 'vitest';
import { mergeGroupsIntoRoles, parseRolesYaml } from '../../access-model/access-grammar.js';
import { sharedFileRulesSection } from '../../agent-instructions/shared-file-rules.js';
import {
  CORE_SECTION_IDS,
  PLATFORM_GUIDE_SEPARATOR,
  WORKING_WITH_FILES_SECTION_ID,
  agentGuideSections,
  composeAgentGuide,
  coreAgentGuideSections,
  isAgentGuidePath,
  isManagedGuide,
  joinGuideSections,
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

  it('says it is served, not written, and names the one file it is read as', async () => {
    const intro = section(await composeAgentGuide(DEFAULT_KB_LAYOUT), '# Knowledge base').replace(/\n> ?/g, ' ');
    expect(intro).toContain('**This guide is served by the platform.**');
    expect(intro).toContain('`get_agent_guide` returns it, whole or one section at a time');
    expect(intro).toContain('`read_file` on `AGENTS.md` at the repository root');
    expect(intro).toContain('`grep` searches it there too');
    expect(intro).toContain('never write this text into it');
    // The old header, which proved a file on disk was the platform's, is gone
    // from the served text — or every read would look like a stale copy.
    expect(isManagedGuide(await composeAgentGuide(DEFAULT_KB_LAYOUT))).toBe(false);
    // One name on every deployment: a name saved for the written guide changes nothing.
    const stale = await composeAgentGuide({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    expect(stale).not.toContain('HEXIS.md');
    expect(stale).toBe(await composeAgentGuide(DEFAULT_KB_LAYOUT));
    // And points at the preamble first, before the platform mechanics.
    const guide = await composeAgentGuide(DEFAULT_KB_LAYOUT);
    expect(guide.indexOf('mcp-description.md')).toBeLessThan(guide.indexOf('## Directory Structure'));
    // One line ending throughout, whatever the checkout wrote the files with.
    expect(guide).not.toContain('\r');
  });

  it('serves the guide as sections with titles, the whole being the sections joined', async () => {
    const sections = await agentGuideSections(DEFAULT_KB_LAYOUT);
    expect(sections.map((s) => s.id)).toEqual(CORE_SECTION_IDS);
    expect(sections.find((s) => s.id === 'introduction')!.title).toBe('Knowledge base');
    expect(sections.find((s) => s.id === 'where-a-new-file-goes')!.title).toBe('Where a new file goes');
    expect(sections.find((s) => s.id === 'skills')!.title).toContain('Skills (`Skills/');
    expect(joinGuideSections(sections)).toBe(await composeAgentGuide(DEFAULT_KB_LAYOUT));
    // A heading closed with its own run of `#` is titled without it, and a
    // section that opens with no heading is titled by its id.
    const added = await agentGuideSections(DEFAULT_KB_LAYOUT, (all) => [
      ...all,
      { id: 'custom', body: '## Custom ##\n\nX.\n' },
      { id: 'bare', body: 'No heading here.\n' },
    ]);
    expect(added.find((s) => s.id === 'custom')!.title).toBe('Custom');
    expect(added.find((s) => s.id === 'bare')!.title).toBe('bare');
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

  it('refuses a hook that drops the shared file rules, which every file tool points at', async () => {
    await expect(
      composeAgentGuide(DEFAULT_KB_LAYOUT, (sections) => sections.filter((s) => s.id !== WORKING_WITH_FILES_SECTION_ID)),
    ).rejects.toThrow(/dropped the "working-with-files" section/);
    // Replacing it under the same id is the hook's right.
    const replaced = await composeAgentGuide(DEFAULT_KB_LAYOUT, (sections) =>
      sections.map((s) => (s.id === WORKING_WITH_FILES_SECTION_ID ? { id: s.id, body: '## Working with files\n\nOurs.\n' } : s)),
    );
    expect(section(replaced, '## Working with files')).toContain('Ours.');
  });

  it('names the checkout folder this deployment uses, so the paths it shows are the paths the tools take', async () => {
    const guide = await composeAgentGuide(DEFAULT_KB_LAYOUT, undefined, { kbDirName: 'repo' });
    expect(guide).toContain('repository as the `repo/` folder');
    expect(guide).toContain('`repo/KnowledgeBase/Foo.md`');
    expect(guide).not.toContain('knowledge-base/');
    expect(guide).not.toContain('{{kbDirName}}');
    // Core's own default when none is given.
    expect(await composeAgentGuide(DEFAULT_KB_LAYOUT)).toContain('`knowledge-base/KnowledgeBase/Foo.md`');
  });

  it('puts the knowledge base\'s own file first, then a separator, then the guide — and nothing before the guide when the file is empty', () => {
    const joined = withPlatformGuideAppended('# Acme\r\n\r\nWrite tickets in the present tense.\r\n\r\n', 'THE GUIDE\n');
    expect(joined).toBe(`# Acme\n\nWrite tickets in the present tense.\n\n${PLATFORM_GUIDE_SEPARATOR}\n\nTHE GUIDE\n`);
    expect(PLATFORM_GUIDE_SEPARATOR.startsWith('---\n')).toBe(true);
    // A file with nothing in it has nothing to put first.
    expect(withPlatformGuideAppended('', 'THE GUIDE\n')).toBe('THE GUIDE\n');
    expect(withPlatformGuideAppended('\n\n', 'THE GUIDE\n')).toBe('THE GUIDE\n');
    // Their whitespace is markdown and stays: indentation is code, two
    // trailing spaces are a hard break.
    expect(withPlatformGuideAppended('    code\nline  \nnext\n', 'THE GUIDE\n')).toBe(
      `    code\nline  \nnext\n\n${PLATFORM_GUIDE_SEPARATOR}\n\nTHE GUIDE\n`,
    );
  });

  it('answers at AGENTS.md in the repository root, and nowhere else', () => {
    expect(isAgentGuidePath('AGENTS.md')).toBe(true);
    expect(isAgentGuidePath('/AGENTS.md')).toBe(true);
    expect(isAgentGuidePath('Handbook/AGENTS.md')).toBe(false);
    expect(isAgentGuidePath('agents.md')).toBe(false);
    expect(isAgentGuidePath('HEXIS.md')).toBe(false);
    expect(isAgentGuidePath('')).toBe(false);
  });

  it('recognises a copy an earlier release wrote to disk by its header line, and nothing else', () => {
    // The header as every release wrote it: a blockquote under the title.
    expect(isManagedGuide('# Knowledge base\n\n> **This file is managed by the platform.** It lives at…\n')).toBe(true);
    expect(isManagedGuide('# Company Knowledge graph\n\nThis is a git-backed knowledge graph.\n\n> **This file is managed by the platform.** Every server restart\n> replaces it.\n')).toBe(true);
    expect(isManagedGuide('# Acme conventions\n\nThis file is managed by us.\n')).toBe(false);
    // The organisation's own note that QUOTES the platform's sentence in its
    // body is theirs: the sentence is not in a header blockquote near the top.
    expect(isManagedGuide('# On the old guide\n\nThe platform used to write a file that opened with **This file is managed by the platform.** and refreshed it.\n')).toBe(false);
    const deep = `# Notes\n${'\n'.repeat(20)}> **This file is managed by the platform.** (quoted from the old guide)\n`;
    expect(isManagedGuide(deep)).toBe(false);
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

  /**
   * The personal plugin, where the placement rule was being read backwards.
   * Nothing under the plugins root is in the knowledge graph, and a personal
   * plugin is readable only by its owner — so a note filed there is never found
   * as knowledge again, by anyone. Agents asked to "save this for me" were
   * taking "a personal space" as the place to put it.
   */
  it('says a personal plugin holds only skills and tools, and what to do when a user wants a note private', async () => {
    const guide = await composeAgentGuide({ knowledgeBaseDir: 'Docs', skillsDir: 'Abilities', pluginsDir: 'Extensions' });
    const placement = section(guide, '## Where a new file goes').replace(/\s+/g, ' ');
    expect(placement).toContain("A personal plugin holds only its owner's skills and tools");
    expect(placement).toContain('Extensions/personal-<id>/');
    // A skill's own bundled files are part of the skill and stay welcome, so the
    // rule does not deter an agent from writing a COMPLETE skill.
    expect(placement).toContain("each skill's own bundled files");
    expect(placement).toContain("inside that skill's folder included");
    expect(placement).toContain('never a note or any other document');
    // A private request gets a question and the restrictable folder, in the
    // deployment's own root name.
    expect(placement).toContain('ask where under `Docs/` it should go');
    expect(placement).toContain('restricted so only they can read it');
    // And when the user insists, the agent declines, says why, and offers again.
    expect(placement).toContain('If they insist on the personal plugin, decline');
    expect(placement).toContain('sits outside the knowledge graph, where it is never found as knowledge again');
    expect(placement).toContain('offer a place under `Docs/` once more');
    // Nothing tells the agent to move or flag documents already filed there.
    expect(placement).not.toMatch(/\bmove (them|it|any)\b/);
  });

  /**
   * Every agent-facing mention of the folder calls it the "personal plugin" —
   * the name the app itself shows. The three phrases the guide used instead are
   * what an agent matched "keep this private" against, so they are pinned out
   * of the WHOLE guide rather than out of one section.
   */
  it('calls the folder the "personal plugin" everywhere, and no longer a "space"', async () => {
    for (const layout of [DEFAULT_KB_LAYOUT, { knowledgeBaseDir: 'Docs', skillsDir: 'Abilities', pluginsDir: 'Extensions' }]) {
      const guide = await composeAgentGuide(layout);
      for (const retired of ['personal space', 'private space', 'own space']) {
        expect(guide, retired).not.toContain(retired);
      }
      const plugins = 'pluginsDir' in layout ? layout.pluginsDir : DEFAULT_KB_LAYOUT.pluginsDir;
      // The four places that introduce it: the `my_plugin` bullet, the sentence
      // on moving a skill, the placement rule, and the `everyone` note.
      expect(guide).toContain("`my_plugin` — your user's personal plugin, holding their own skills and\n  tools");
      expect(guide).toContain('A skill\nmoves from a personal plugin into a shared plugin by moving its folder.');
      expect(guide).toContain("A person's private skill goes in their personal plugin");
      expect(guide).toContain(`A person's personal plugin\n  (\`${plugins}/personal-<id>/\`) denies \`everyone\` outright`);
    }
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
