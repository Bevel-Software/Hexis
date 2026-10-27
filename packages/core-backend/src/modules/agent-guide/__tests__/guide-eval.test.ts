import { DEFAULT_KB_LAYOUT } from '@bevel-software/platform-shared';
import { describe, expect, it } from 'vitest';
import { countTokens } from '../../../__tests__/tokens.js';
import { START_HERE_SECTION_ID, agentGuideSections } from '../agent-guide.js';
import { TASK_TOKEN_BUDGET } from '../guide-budget.js';

/**
 * The evaluation in openspec/changes/agent-guide-layers/design.md, as a test.
 *
 * Ten first-contact tasks from a customer's first day on the platform
 * (2026-10-19), each with the facts the guide must let an agent get right.
 * For each task: the start section routes its questions to every section
 * named here (at most two), those sections and the start section state every fact,
 * and reading them costs at most one task's budget. Before the change, 27 of
 * these 53 facts were stated and every task cost the whole guide.
 *
 * A fact is pinned by the phrase that states it, so rewording a fact means
 * rewording its phrase here: on purpose, as that is the moment to check the
 * fact survived. Matched with whitespace collapsed and emphasis removed.
 */

interface Task {
  task: string;
  /** A phrase of each start-section question that routes this task: one per section it reads. */
  asks?: string[];
  sections: string[];
  facts: Array<[fact: string, phrase: RegExp]>;
}

const TASKS: Task[] = [
  {
    task: '1. What is this knowledge base, and how does my agent get its context?',
    asks: ['What does my agent see when it connects'],
    sections: ['how-agents-find-things'],
    facts: [
      ['not explained as a Git repo', /do not explain it as "a Git repo"/],
      ['what the agent has on connect', /When an agent connects, it has three things and no more/],
      ['the rest is fetched, never all of it', /No agent reads the whole knowledge base/],
      ['descriptions and links bring context', /A skill's description decides when the skill is loaded.*Links between pages/],
      ['a snippet for the local AGENTS.md', /the one text an agent always reads in a repository is that repository's `AGENTS\.md` or `CLAUDE\.md`.*## Organisation knowledge/],
    ],
  },
  {
    task: '2. Read a page, list a folder: the first calls',
    sections: [],
    facts: [
      ['every file tool takes branch, and which is live', /Every file tool takes `branch`\. `main` is the default branch: what is live/],
      ['paths sit under the checkout folder', /Paths sit under `knowledge-base\/`/],
      ['sessionId only where listed', /Pass `sessionId` only where a tool lists it/],
      ['copy the Call: line', /Copy each tool's `Call:` line/],
      ['grep takes RE2-style patterns', /`grep` takes RE2-style regular expressions \(ripgrep\): no look-around and no backreferences/],
    ],
  },
  {
    task: '3. Make a skill on my branch and see it',
    asks: ['How do I write a skill'],
    sections: ['skills'],
    facts: [
      ['where a skill lives', /A skill is a folder holding a `SKILL\.md`/],
      ['quote YAML values', /Quote a value that contains `: `/],
      ['a draft shows in Knowledge', /choose the draft in the branch switcher and it shows in Knowledge/],
      ['the catalog shows only merged skills', /A skill on a draft is not live.*pass the draft: `list_skills/],
      ['tools likewise', /Skills and tools go live only once they are on `main`/],
    ],
  },
  {
    task: "4. Why can't I delete this?",
    asks: ["Why can't I delete this?", 'moves, deletes'],
    sections: ['for-git-users', 'working-with-files'],
    facts: [
      ['on a draft, anything you can read, unseen until merged', /On your draft you can do anything to what you can read.*Nobody else sees it until the draft is merged/],
      ['on a protected branch, write per file or propose', /On a protected branch, write access is checked per file.*how to propose it instead/],
      ['some platform files are never deleted', /are deleted by nobody/],
      ['file_stat says what may be deleted', /file_stat reports `managed`, `movable` and `deletable`/],
      ['what you cannot read you cannot change', /What you cannot read you cannot see or change, on any branch/],
    ],
  },
  {
    task: '5. Is this like Git? Who merges?',
    asks: ['How is this like Git'],
    sections: ['for-git-users'],
    facts: [
      ['drafts, and a protected default branch', /Work in progress goes on a draft branch/],
      ['the agent opens, a person merges', /a person reviews, approves and merges it in the app\. No agent tool approves or merges one/],
      ['access per folder, with an example', /Per folder and per file.*An example\. A team keeps its specs/],
      ['merging is where owners approve', /Merging is where the owners of the files approve/],
      ['saving shares, no git', /you have no git command.*Every save is committed and shared as the person/],
      ['not explained as a Git repo', /do not explain it as "a Git repo"/],
    ],
  },
  {
    task: "6. Set up a team's first project",
    asks: ["lay out a team's first project"],
    sections: ['where-a-new-file-goes'],
    facts: [
      ['where documents, skills and tools go', /A document goes under `KnowledgeBase\/`.*A shared skill goes under `Skills\/`.*Tool manuals, MCP servers and manifests go inside a plugin/],
      ['a starter layout, one question in one place', /### A team's first project.*One question, one place/],
      ['a folder can be restricted', /Give the team's folder an `access\.md`/],
      ['search before creating', /Search first: when another team already covers a subject, link to its page/],
      ['ask when the place is unclear', /When the place does not exist, or nothing fits, ask/],
    ],
  },
  {
    task: '7. Plugin, MCP server, tool, skill, secret, OAuth, role, group, access.md: what is each?',
    asks: ['What is a plugin, a skill, a tool'],
    sections: ['glossary'],
    facts: [
      ['plugin', /- Plugin: a package/],
      ['MCP server', /- MCP server: a connection to another service/],
      ['tool', /- Tool: one action an agent can call/],
      ['skill', /- Skill: a folder with a `SKILL\.md`/],
      ['secret, shared and personal', /- Secret: a credential.*A shared \(admin\) secret.*A personal \(user\) secret/],
      ['sign-in', /- Sign-in \(OAuth\): a personal secret filled by signing in/],
      ['role', /- Role: a capability the platform defines/],
      ['group', /- Group: a named set of people/],
      ['access.md', /- `access\.md`: a folder's rules/],
    ],
  },
  {
    task: '8. I merged a tool: when can I, and Langdock, use it?',
    asks: ['When can I use a tool'],
    sections: ['tools'],
    facts: [
      ['served from the default branch only', /Tools are served from the default branch only/],
      ['then each person signs in on the Connect page', /each person sets theirs on the Connect page/],
      ['then the client lists again, or reconnects', /The client lists the tools again.*must reconnect/],
      ['a connection-key client sees only set-up tools', /A client connected with a connection key.*only the tools whose personal secrets/],
      ['list_tool_setup shows what is missing', /When a tool is not working, call `list_tool_setup`/],
    ],
  },
  {
    task: '9. Make my skill check its tools first',
    asks: ['When can I use a tool', 'How do I write a skill'],
    sections: ['skills', 'tools'],
    facts: [
      ['name the tools in allowed-tools', /`allowed-tools` names the tools the skill uses/],
      ['check with list_tool_setup and stop with an instruction', /A skill that needs tools checks them first.*Call `list_tool_setup`.*stop and say/],
      ['never ask for a secret', /Never ask for an API key, token or client secret in the conversation/],
    ],
  },
  {
    task: '10. A guided skill for a colleague who is not technical',
    asks: ['or one for people who are not technical'],
    sections: ['skills'],
    facts: [
      ['one question per message', /One question per message/],
      ['proposals they confirm', /Propose, then ask them to confirm/],
      ['a checklist for "specified enough"', /A checklist for "specified enough"/],
      ['plain words', /Plain words\. No platform terms/],
      ['it reaches them only after merge', /A skill on a draft is not live/],
    ],
  },
];

const flat = (markdown: string): string => markdown.replace(/\*+/g, '').replace(/\s+/g, ' ');

describe('the evaluation tasks are answered by the start section and at most two more', () => {
  it('has the 53 facts design.md lists', () => {
    expect(TASKS).toHaveLength(10);
    expect(TASKS.reduce((n, t) => n + t.facts.length, 0)).toBe(53);
  });

  it.each(TASKS.map((t) => [t.task, t] as const))('%s', async (_name, task) => {
    const sections = await agentGuideSections(DEFAULT_KB_LAYOUT, undefined, { defaultBranch: 'main' });
    const byId = new Map(sections.map((s) => [s.id, s.body]));
    const start = byId.get(START_HERE_SECTION_ID)!;
    expect(task.sections.length).toBeLessThanOrEqual(2);
    // Every section the task reads is one the start section routes it to.
    const routedTo = (task.asks ?? []).map((asks) => {
      const row = start.split('\n').find((line) => line.startsWith('|') && line.includes(asks));
      expect(row, `the start section has no question with "${asks}"`).toBeDefined();
      return /`([a-z0-9-]+)`\s*\|$/.exec(row!)?.[1];
    });
    for (const id of task.sections) expect(routedTo, `no start-section question routes to ${id}`).toContain(id);
    const read = [start, ...task.sections.map((id) => byId.get(id)!)];
    const text = flat(read.join('\n\n'));
    const missing = task.facts.filter(([, phrase]) => !phrase.test(text)).map(([fact]) => fact);
    expect(missing, 'facts the routed sections no longer state').toEqual([]);
    const tokens = read.reduce((n, body) => n + countTokens(body), 0);
    expect(tokens, `the task costs ${tokens} tokens (budget ${TASK_TOKEN_BUDGET})`).toBeLessThanOrEqual(TASK_TOKEN_BUDGET);
  });
});
