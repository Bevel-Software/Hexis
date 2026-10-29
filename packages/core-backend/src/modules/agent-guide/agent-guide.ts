/**
 * The platform's agent guide: what every agent is told to read before its
 * first read or change in a knowledge base — the layout, where a new file
 * goes, the rules every file tool shares, access control, skills and tool
 * manuals.
 *
 * It is TEXT THE CODE OWNS, not a file in the repository. It used to be
 * written to every protected branch as `AGENTS.md` and refreshed on every
 * start, which had three costs: a repository that already had an `AGENTS.md`
 * of its own lost it or had to rename ours; a distribution that wanted to add
 * to the guide had to fork the whole file and then drifted from every change
 * made here; and the file sat in git history on every branch, hidden from the
 * tree by an ignore rule it had to keep writing. Now the guide is composed
 * from SECTIONS at the moment an agent asks for it — `get_agent_guide`, or a
 * `read_file` of the guide's name at the repository root — and a distribution
 * shapes it with a hook that sees the sections and returns the sections it
 * wants (append, replace or drop by id), so what Hexis says reaches it without
 * a copy to maintain.
 *
 * The sections ship as markdown files in the package's `agent-guide/` folder
 * (see `assets.ts`), one per section, with the layout placeholders the old
 * template carried (`{{knowledgeBaseDir}}`, `{{skillsDir}}`, `{{pluginsDir}}`,
 * `{{agentsFile}}`), the checkout folder's `{{kbDirName}}` and the default
 * branch's `{{defaultBranch}}`. ONE section is computed rather than read: the
 * rules every file tool shares, which the MCP handshake also sends — the same
 * string in both places, from `shared-file-rules.ts`, so a rule cannot be
 * changed in one and left stale in the other.
 *
 * The guide is LAYERED (see openspec/changes/agent-guide-layers/design.md):
 * `get_agent_guide` with no section answers with the short start section
 * ({@link START_HERE_SECTION_ID}), which says which section answers which
 * question, and an agent fetches the others by id when a task needs them.
 * Each section has a token budget (`guide-budget.ts`), held by a test.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {

  renderKbLayoutPlaceholders,
  resolveKbLayout,
  type KbLayout,
} from '@bevel-software/platform-shared';
import { agentGuideDir } from '../../assets.js';
import { sharedFileRulesSection } from '../agent-instructions/index.js';

/** One section of the guide. */
export interface AgentGuideSection {
  /**
   * Stable id, so a distribution's hook can replace or drop a section by name
   * and a test can say which one went missing. Core's ids are the
   * {@link CORE_SECTION_IDS}.
   */
  id: string;
  /**
   * The section's markdown, heading included (`## …`). May carry the layout
   * placeholders; they are rendered with the names in effect when the guide is
   * composed, so a section can name the knowledge folder without knowing what
   * this deployment calls it.
   */
  body: string;
  /**
   * The body is FINAL: already rendered, and not to be passed through the
   * placeholder renderer. Set on the computed shared-rules section, which is
   * rendered for the layout by the code that builds it; rendering it again
   * could only misread a folder name it STATES as a placeholder.
   */
  literal?: boolean;
  /**
   * The question this section answers, as a row of the start section's
   * "which section answers what" table. Core's sections are in that table
   * already; a distribution sets it on a section it adds, so an agent that
   * reads only the start section is routed to it.
   */
  asks?: string;
}

/**
 * A distribution's say over the guide. Called with core's sections, in order,
 * and the layout in effect; returns the sections the guide is composed from.
 * Append to the array to add sections, map over it to replace one by id,
 * filter it to drop one. Called on every composition, so a hook that reads
 * something live (a feature flag, a setting) is read each time.
 */
export type AgentGuideHook = (
  sections: readonly AgentGuideSection[],
  layout: Required<KbLayout>,
) => readonly AgentGuideSection[] | Promise<readonly AgentGuideSection[]>;

/** Composes the guide for the layout in effect — the shape every consumer reads. */
export type AgentGuideReader = () => Promise<string>;

/** The computed section: the rules every file tool shares. */
export const WORKING_WITH_FILES_SECTION_ID = 'working-with-files';

/**
 * What to do on a knowledge base nobody has written in yet: the section the
 * `firstRun` note `start_session` answers with points at (see
 * workspace/first-run.ts, which names it by this constant).
 */
export const NEW_KNOWLEDGE_BASE_SECTION_ID = 'new-knowledge-base';

/**
 * The first-contact section: what `get_agent_guide` answers when no section is
 * named. Short on purpose, and the one place that maps each question to the
 * section answering it, so an agent fetches one section rather than the guide.
 */
export const START_HERE_SECTION_ID = 'start-here';

/** The `section` that asks `get_agent_guide` for every section at once. */
export const WHOLE_GUIDE_SECTION = 'all';

/**
 * Core's sections, in reading order. Every id but the shared-rules one names
 * a file in the package's `agent-guide/` folder.
 */
export const CORE_SECTION_IDS: readonly string[] = Object.freeze([
  START_HERE_SECTION_ID,
  'how-agents-find-things',
  'for-git-users',
  'glossary',
  'directory-structure',
  'where-a-new-file-goes',
  WORKING_WITH_FILES_SECTION_ID,
  'access-control',
  'drafts-and-change-requests',
  'skills',
  'tools',
  'tool-manuals',
  'html-views',
  'conventions',
  NEW_KNOWLEDGE_BASE_SECTION_ID,
]);

/**
 * The one line that proves a root guide file is the platform's and not the
 * customer's: the blockquote the packaged guide opened with for as long as
 * the guide was a file, under every release. Asked for WHERE the header put
 * it — a blockquote line among the first lines of the file — and not anywhere
 * in the text: a note of the organisation's own that quotes the platform's
 * sentence in its body must not read as ours, because the consequence of the
 * mistake is a deletion. Still read on every start, to take the copies
 * earlier releases wrote out of the repository (see template-files.step.ts),
 * and on every read of the guide's name, so a copy still on a draft is not
 * served twice.
 */
const MANAGED_GUIDE_HEADER_LINE = '> **This file is managed by the platform.**';

/** How far down a file the header's blockquote can sit: under the title and a sentence or two, never further. */
const MANAGED_GUIDE_HEADER_WITHIN_LINES = 12;

/** Whether `text` is a copy of the guide a release wrote to disk, of any vintage. */
export function isManagedGuide(text: string): boolean {
  return text
    .split('\n', MANAGED_GUIDE_HEADER_WITHIN_LINES)
    .some((line) => line.trimStart().startsWith(MANAGED_GUIDE_HEADER_LINE));
}

/** The raw section files, read once per process: the package does not change while it runs. */
let coreSectionFiles: Promise<ReadonlyMap<string, string>> | null = null;

async function readCoreSectionFiles(): Promise<ReadonlyMap<string, string>> {
  const dir = agentGuideDir();
  const entries = await Promise.all(
    CORE_SECTION_IDS.filter((id) => id !== WORKING_WITH_FILES_SECTION_ID).map(
      // Line endings normalised: a checkout on Windows may carry CRLF, and the
      // guide is one text with one ending wherever it is served from.
      async (id) => [id, (await fs.readFile(path.join(dir, `${id}.md`), 'utf8')).replace(/\r\n?/g, '\n')] as const,
    ),
  );
  return new Map(entries);
}

/**
 * Core's sections for `layout`: the files, placeholders unrendered, with the
 * shared-rules section computed and in its place. What a distribution's hook
 * is handed.
 */
export async function coreAgentGuideSections(layout: KbLayout): Promise<AgentGuideSection[]> {
  coreSectionFiles ??= readCoreSectionFiles();
  let files: ReadonlyMap<string, string>;
  try {
    files = await coreSectionFiles;
  } catch (err) {
    // A failed read is not cached: the next composition tries the disk again.
    coreSectionFiles = null;
    throw err;
  }
  return CORE_SECTION_IDS.map((id) =>
    id === WORKING_WITH_FILES_SECTION_ID
      ? { id, body: sharedFileRulesSection(layout), literal: true }
      : { id, body: files.get(id)! },
  );
}

/** What the guide is composed for, beyond the layout. */
export interface AgentGuideContext {
  /**
   * The name of the repository's checkout folder inside a workspace, which
   * the file tools take paths under (`knowledge-base/` by default). Rendered
   * into `{{kbDirName}}` so the paths the guide shows are the paths this
   * deployment's tools report back.
   */
  kbDirName?: string;
  /**
   * The knowledge base's default branch, rendered into `{{defaultBranch}}` so
   * the start section names the branch every file tool's `branch` takes for
   * what is live. Read when the guide is composed: a fresh deployment gets its
   * branch model from the setup screen after the services are built.
   */
  defaultBranch?: string;
}

/** The checkout folder's name when none is given — core's own default. */
const DEFAULT_KB_DIR_NAME = 'knowledge-base';

/** What `{{defaultBranch}}` reads as when no branch is configured yet: a name no branch can have. */
const UNCONFIGURED_DEFAULT_BRANCH = '<the default branch>';

/** One section of the guide as an agent reads it: rendered, with the heading's text as its title. */
export interface RenderedGuideSection {
  id: string;
  /** The heading line's text, without its `#`s — what the tool lists the section as. */
  title: string;
  /** The section's markdown, heading included, rendered for the layout. */
  body: string;
}

/** Composes the guide's sections for the layout in effect — what the guide tool reads. */
export type AgentGuideSectionsReader = () => Promise<RenderedGuideSection[]>;

/**
 * The guide's sections as an agent reads them: core's sections through the
 * distribution's hook (when there is one), rendered for the layout, each
 * with its title. The whole guide is these joined (see
 * {@link composeAgentGuide}); `get_agent_guide` also serves one at a time.
 *
 * A hook may append, replace and drop sections. It replaces one by returning
 * its own under the same id, beside core's or in its place: of two sections
 * under one id the LAST is served, where the FIRST stood, so a distribution
 * overrides core's `start-here` or `html-views` by adding its own and the
 * guide keeps its order (see {@link oneSectionPerId}). ONE exception: the
 * shared file rules ({@link WORKING_WITH_FILES_SECTION_ID}) must come back
 * WITH TEXT IN THEM, as core's or as the hook's own replacement. A client
 * that drops the handshake instructions has the guide as the only place to
 * read the rules — a guide without them would leave agents nothing to read.
 * A hook that drops the section, or hands it back empty, is a composition
 * error, thrown rather than served. Judged on what would be SERVED — the
 * rendered, trimmed body — so a replacement of whitespace is caught like a
 * missing one, rather than passing the check and vanishing with the other
 * empty sections below.
 */
export async function agentGuideSections(
  layout: KbLayout,
  hook?: AgentGuideHook,
  context: AgentGuideContext = {},
): Promise<RenderedGuideSection[]> {
  const resolved = resolveKbLayout(layout);
  const core = await coreAgentGuideSections(resolved);
  const sections = withRoutes(oneSectionPerId(hook ? await hook(core, resolved) : core));
  const kbDirName = context.kbDirName?.trim() || DEFAULT_KB_DIR_NAME;
  const defaultBranch = context.defaultBranch?.trim() || UNCONFIGURED_DEFAULT_BRANCH;
  const rendered = sections.map((section) => {
    const body = (
      section.literal
        ? section.body
        : renderKbLayoutPlaceholders(
            section.body
              .replaceAll('{{kbDirName}}', () => kbDirName)
              .replaceAll('{{defaultBranch}}', () => defaultBranch),
            resolved,
          )
    ).trim();
    return { id: section.id, title: titleOf(body, section.id), body };
  });
  // One section per id by now (`oneSectionPerId`), so a hook's own version
  // of the rules is what is judged, on what survives the empty-body filter
  // below.
  const rules = rendered.filter((section) => section.id === WORKING_WITH_FILES_SECTION_ID);
  if (!rules.some((section) => section.body.length > 0)) {
    throw new Error(
      `The agent guide hook ${rules.length === 0 ? 'dropped' : 'emptied'} the "${WORKING_WITH_FILES_SECTION_ID}" ` +
        'section, which every file tool points at. Keep it, or replace it under the same id with the rules in it.',
    );
  }
  return rendered.filter((section) => section.body.length > 0);
}

/**
 * One section per id. A hook that returns an id twice (its own version of a
 * core section, added beside core's) means the later one: it is served in
 * the earlier one's place, so a distribution overrides a section by adding
 * its own under the same id, and the guide keeps core's order. Without this
 * the whole guide carried both and `get_agent_guide` served the first, which
 * was always core's.
 */
function oneSectionPerId(sections: readonly AgentGuideSection[]): readonly AgentGuideSection[] {
  const at = new Map<string, number>();
  const out: AgentGuideSection[] = [];
  for (const section of sections) {
    const index = at.get(section.id);
    if (index === undefined) {
      at.set(section.id, out.length);
      out.push(section);
    } else {
      out[index] = section;
    }
  }
  return out;
}

/**
 * Adds a row to the start section's routing table for every section that
 * says what it {@link AgentGuideSection.asks} and is not routed there yet.
 * The rows go after the table's last row. A start section without the table
 * (a distribution replaced it) is left as it is.
 */
function withRoutes(sections: readonly AgentGuideSection[]): readonly AgentGuideSection[] {
  const start = sections.find((section) => section.id === START_HERE_SECTION_ID);
  if (!start) return sections;
  const routed = sections.filter((section) => section.asks?.trim() && !start.body.includes(`| \`${section.id}\` |`));
  if (routed.length === 0) return sections;
  const lines = start.body.split('\n');
  const header = lines.findIndex((line) => /^\|\s*Question\s*\|\s*Section\s*\|/.test(line));
  if (header < 0) return sections;
  let last = header;
  while (last + 1 < lines.length && lines[last + 1]!.startsWith('|')) last += 1;
  const rows = routed.map((section) => `| ${section.asks!.trim().replaceAll('|', '\\|')} | \`${section.id}\` |`);
  lines.splice(last + 1, 0, ...rows);
  const body = lines.join('\n');
  return sections.map((section) => (section === start ? { ...start, body } : section));
}

/**
 * The heading's text, or the id when the section opens with no heading. An
 * ATX heading may close with a run of `#` of its own (`## Custom ##`); that
 * is a delimiter, not part of the title.
 */
function titleOf(body: string, id: string): string {
  const first = body.split('\n', 1)[0] ?? '';
  const heading = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(first);
  return heading ? heading[1]!.trim() : id;
}

/**
 * The guide as an agent reads it whole: the sections joined by blank lines,
 * ending in one newline.
 */
export async function composeAgentGuide(
  layout: KbLayout,
  hook?: AgentGuideHook,
  context: AgentGuideContext = {},
): Promise<string> {
  return joinGuideSections(await agentGuideSections(layout, hook, context));
}

/**
 * What a `read_file` of the guide's name answers: the start section and the
 * list of every section, the same as `get_agent_guide` with no `section`, so
 * no read hands an agent the whole guide unless it asks for it. A guide
 * without a start section (a distribution dropped it) is answered whole.
 */
export function guideStartText(sections: readonly RenderedGuideSection[]): string {
  const start = sections.find((section) => section.id === START_HERE_SECTION_ID);
  if (!start) return joinGuideSections(sections);
  const list = sections.map((section) => `- \`${section.id}\`: ${section.title}`).join('\n');
  return `${start.body}\n\n### Every section\n\n${list}\n`;
}

/** The sections as one document, the way `composeAgentGuide` joins them. */
export function joinGuideSections(sections: readonly RenderedGuideSection[]): string {
  return `${sections.map((section) => section.body).join('\n\n')}\n`;
}

/**
 * What a `read_file` of the guide's name answers when the knowledge base has an
 * `AGENTS.md` of its own: their text first, whole, then a rule and one line
 * saying what follows, then the start of the platform's guide. Theirs first because it is
 * the more specific of the two, and the line between so neither is read as
 * part of the other.
 */
export const PLATFORM_GUIDE_SEPARATOR =
  "---\n\n_The text above is this knowledge base's own conventions file. The start of the platform's guide follows; `get_agent_guide` with a `section` returns the rest._";

export function withPlatformGuideAppended(ownText: string, guide: string): string {
  // Their text as they wrote it, line endings normalised and the trailing
  // newlines folded into the one blank line before the separator. Nothing
  // else is touched: leading indentation and trailing spaces are markdown.
  const own = ownText.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  // A file with nothing in it has nothing to put first, and a separator
  // above nothing would claim a conventions file that says nothing.
  if (own.trim().length === 0) return guide;
  return `${own}\n\n${PLATFORM_GUIDE_SEPARATOR}\n\n${guide}`;
}

/** The one name the guide is read by: `AGENTS.md` at the repository root, the name coding agents look for. */
export const AGENT_GUIDE_FILE = 'AGENTS.md';

/**
 * Whether a repository-relative path is where the guide is read — `AGENTS.md`
 * at the repository root, exactly spelled, like every platform path. One
 * name on every deployment: there is no setting for it any more.
 */
export function isAgentGuidePath(repoRelativePath: string): boolean {
  const norm = repoRelativePath.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  return norm === AGENT_GUIDE_FILE;
}
