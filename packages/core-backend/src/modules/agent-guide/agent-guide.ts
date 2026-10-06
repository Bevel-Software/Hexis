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
 * `{{agentsFile}}`). ONE section is computed rather than read: the rules every
 * file tool shares, which the MCP handshake also sends — the same string in
 * both places, from `shared-file-rules.ts`, so a rule cannot be changed in one
 * and left stale in the other.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {

  renderKbLayoutPlaceholders,
  resolveKbLayout,
  type KbLayout,
} from '@bevel-software/platform-shared';
import { agentGuideDir } from '../../assets.js';
import { sharedFileRulesSection } from '../agent-instructions/shared-file-rules.js';

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
 * Core's sections, in reading order. Every id but the shared-rules one names
 * a file in the package's `agent-guide/` folder.
 */
export const CORE_SECTION_IDS: readonly string[] = Object.freeze([
  'introduction',
  'directory-structure',
  'where-a-new-file-goes',
  WORKING_WITH_FILES_SECTION_ID,
  'access-control',
  'skills',
  'tool-manuals',
  'conventions',
  'finding-things',
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
}

/** The checkout folder's name when none is given — core's own default. */
const DEFAULT_KB_DIR_NAME = 'knowledge-base';

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
 * A hook may append, replace and drop sections, with ONE exception: the
 * shared file rules ({@link WORKING_WITH_FILES_SECTION_ID}) must come back,
 * as core's or as the hook's own replacement. A client that drops the
 * handshake instructions has the guide as the only place to read the rules
 * — a guide without them would leave agents nothing to read. A hook that
 * drops it is a composition error, thrown rather than served.
 */
export async function agentGuideSections(
  layout: KbLayout,
  hook?: AgentGuideHook,
  context: AgentGuideContext = {},
): Promise<RenderedGuideSection[]> {
  const resolved = resolveKbLayout(layout);
  const core = await coreAgentGuideSections(resolved);
  const sections = hook ? await hook(core, resolved) : core;
  if (!sections.some((section) => section.id === WORKING_WITH_FILES_SECTION_ID)) {
    throw new Error(
      `The agent guide hook dropped the "${WORKING_WITH_FILES_SECTION_ID}" section, which every file tool points at. ` +
        'Keep it, or replace it under the same id.',
    );
  }
  const kbDirName = context.kbDirName?.trim() || DEFAULT_KB_DIR_NAME;
  return sections
    .map((section) => {
      const body = (
        section.literal
          ? section.body
          : renderKbLayoutPlaceholders(section.body.replaceAll('{{kbDirName}}', () => kbDirName), resolved)
      ).trim();
      return { id: section.id, title: titleOf(body, section.id), body };
    })
    .filter((section) => section.body.length > 0);
}

/** The heading's text, or the id when the section opens with no heading. */
function titleOf(body: string, id: string): string {
  const first = body.split('\n', 1)[0] ?? '';
  const heading = /^#{1,6}\s+(.*)$/.exec(first);
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

/** The sections as one document, the way `composeAgentGuide` joins them. */
export function joinGuideSections(sections: readonly RenderedGuideSection[]): string {
  return `${sections.map((section) => section.body).join('\n\n')}\n`;
}

/**
 * What a `read_file` of the guide's name answers when the knowledge base has an
 * `AGENTS.md` of its own: their text first, whole, then a rule and one line
 * saying what follows, then the platform's guide. Theirs first because it is
 * the more specific of the two, and the line between so neither is read as
 * part of the other.
 */
export const PLATFORM_GUIDE_SEPARATOR =
  "---\n\n_The text above is this knowledge base's own conventions file. The platform's guide follows; `get_agent_guide` returns it on its own._";

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
