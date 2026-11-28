/**
 * What a connected agent is told at the start of an MCP session, composed
 * from two layers: a platform opening the code owns (what Hexis is, when to
 * use it, where the rules every file tool shares are, and the default
 * branch), then the deployment preamble an admin writes in
 * `mcp-description.md` at the repository root. The shared rules themselves
 * (`shared-file-rules.ts`) are in the guide only: with them in front, Claude
 * Code cut the text before the preamble began.
 *
 * Two channels carry the result. The full text goes out as `instructions` on
 * the initialize handshake, which Claude Code, Claude Desktop and Cursor place
 * in the model's system prompt. claude.ai on the web, the Agent SDK and Cline
 * drop that field, so a short prefix is also prepended to the descriptions of
 * the four knowledge-base tools (the one pre-call channel every client shows
 * the model). Both are capped, because both land in every conversation.
 *
 * Pure: no IO, no clock. The reader beside it (`read-preamble.ts`) does the
 * file access; the hosted proxy, the agent-facing route and the local bridge
 * all read this one composer's output.
 */

// The file, the caps and the comment rule are shared with the frontend
// editor: it shows what these strip and writes back what they allow, so a
// hand-mirrored copy would let the admin's view and the agent's text drift
// apart. Re-exported here because this module is where the backend reads them
// from.
import {
  PREAMBLE_CAP,
  PREAMBLE_FILE,
  TOOL_PREFIX_CAP,
  stripHtmlComments,
} from '@bevel-software/platform-shared';
import { splitCallLine } from '@bevel-software/platform-mcp-core';
import { SHARED_RULES_SECTION, SHARED_RULES_SECTION_ID, defaultBranchSentence } from './shared-file-rules.js';

export { PREAMBLE_CAP, PREAMBLE_FILE, TOOL_PREFIX_CAP };

/**
 * The one tool that returns the platform's guide (see `modules/agent-guide`).
 * Named here, where the text that sends an agent to it is composed, and read
 * from here by tool-registry's guide-first sentence: tool-registry already
 * imports this module (`PREFIXED_TOOLS`), and this module imports no value
 * from any other module, so neither import closes a cycle.
 */
export const GET_AGENT_GUIDE_TOOL = 'get_agent_guide';

/** The tools whose descriptions carry the prefix. Every other tool is untouched. */
export const PREFIXED_TOOLS: ReadonlySet<string> = new Set(['start_session', 'grep', 'list_files', 'read_file']);

/**
 * The platform header, owned by the code. What Hexis is, that its content is
 * not in the model's training data, the order in which to search it, and that
 * skills are reachable as prompts and through the two skill tools.
 */
export const PLATFORM_HEADER =
  "Hexis is this organisation's knowledge base, together with the skills and tools its teams have approved. " +
  'Its content is specific to the organisation and is not in your training data. ' +
  'Before answering a question about the organisation, its people, customers, products, processes, projects or internal terms, ' +
  'search the knowledge base: call `start_session` once, then `grep` for the key terms, `list_files` to orient, and `read_file` what matches. ' +
  'Prefer what you find there over memory or the web, and say so when the knowledge base is silent on something the organisation should have documented. ' +
  'Skills are available as prompts and through `list_skills` and `get_skill`. ' +
  // Not said here: how to onboard someone new. The guide's start routes that
  // question to the `onboarding` section, and that row is what the agents
  // read (the agent-guide benchmark, 2026-10-29: every onboarding run reached
  // the section through `start-here`, including the runs in clients that
  // drop `instructions` — claude.ai on the web, the Agent SDK, Cline). The
  // handshake stays the text an agent gets before it reads the guide, not a
  // second copy of the guide's routing.
  // Said here as well as on the write tools: agents wrote to the default
  // branch without asking (the agent-guide benchmark, 2026-10-26), and this
  // text reaches an agent that never fetches the guide.
  'A write to the default branch is live for everyone: unless the person said where, ask first whether to write there or on a draft. ' +
  // There is no one calling shape to state: the knowledge-base tools take
  // their arguments under `body`, a tool that calls another service takes them
  // flat, and an agent told one rule for all of them sends a GET with a body.
  // The per-tool `Call:` line is generated from each tool's own input schema,
  // so pointing at it is both shorter and always right.
  'Tools do not share one calling shape: call each tool exactly as the `Call:` line at the top of its description shows.';

/**
 * The fixed first line of the tool prefix. It always leads, so an admin's
 * first edit never removes the instruction from the clients that only see
 * tool descriptions, and a preamble that opens with a heading still yields a
 * sensible purpose line.
 */
export const TOOL_PREFIX_LINE = "This organisation's knowledge base. Search it before answering from memory.";

/**
 * The first line of the handshake text, ahead of everything else. Clients cut
 * the instructions they show the model, so the line that must survive the cut
 * comes first: it sends the agent to the guide, the one text that says in full
 * what this deployment is and, for a connection made as an agent, what that
 * connection loads.
 *
 * The same line on every handshake, unconditionally — also on a connection
 * whose `.agent` leaves `get_agent_guide` out of its platform tools. That
 * connection is already told the same thing by the sentence its platform
 * tools' descriptions open with (`GUIDE_FIRST_SENTENCE` in tool-registry), so
 * the line adds no case; which tools a narrowed connection loads is the
 * agent configuration's rule, not this text's, and is left as it is.
 */
export const GUIDE_FIRST_LINE =
  `Before anything else, call \`${GET_AGENT_GUIDE_TOOL}\` and read the guide: it says what this deployment is and what this connection loads.`;

/**
 * Where the rules every file tool shares are, in place of the rules: they run
 * to thousands of characters, and in front of the preamble they pushed it
 * past the point Claude Code cuts at (see {@link INSTRUCTIONS_CAP}).
 */
export const SHARED_RULES_POINTER =
  `The rules every file tool shares (what each kind of file reads and writes as, write modes, uploads, moves and deletes) ` +
  `are in the guide's "${SHARED_RULES_SECTION}" section: call \`get_agent_guide\` with \`section\` \`${SHARED_RULES_SECTION_ID}\`.`;

/**
 * The whole platform-owned part of the handshake text: the guide-first line,
 * what Hexis is and when to use it, where the shared rules are, then the
 * sentence naming the default branch when the deployment has one. This is
 * what the `header` field carries and what the card shows as fixed and not
 * editable; the admin's preamble follows it.
 *
 * A FUNCTION of the default branch, a deployment setting read when composing:
 * every file tool asks for "the branch you are working on", and an agent left
 * to guess guesses `main`. The sentence is the one the guide's shared rules
 * carry, from the same helper.
 */
export function platformInstructions(defaultBranch = ''): string {
  const branch = defaultBranchSentence(defaultBranch);
  const opening = `${GUIDE_FIRST_LINE}\n\n${PLATFORM_HEADER}\n\n${SHARED_RULES_POINTER}`;
  return branch ? `${opening}\n\n${branch}` : opening;
}

/**
 * The ceiling on the composed instructions: the length Claude Code keeps of a
 * server's `instructions`, pinned by a test. Past it Claude Code drops the
 * rest and appends `… [truncated]`, so anything beyond it never reaches the
 * model.
 *
 * Not the ceiling on every handshake. A connection made as an agent gets one
 * more line after these instructions, naming the agent by its name and path
 * (`describeConnection`, appended by both MCP servers). Neither is bounded,
 * so with a preamble near its cap a long name or path takes the handshake
 * past this length, and Claude Code cuts the end of that line. The guide-first
 * line still sends the agent to the guide, which says what the connection
 * loads. A test pins the full handshake of a typical agent connection.
 *
 * Measured, not guessed: Claude Code 2.1.332 (2026-11-26) cuts server
 * instructions at 4,096 characters by default (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`
 * overrides it; a claude.ai connector is not cut). Version 2.1.293 cut at
 * 2,048, which is why the opening and the preamble's start must also sit
 * within the first 2,000 characters. They do for any branch name without
 * backticks: the opening is about 1,450 characters with `main` and 1,700
 * with a 255-character name. A name made mostly of backticks renders as a
 * longer code span and can push the preamble's start past 2,000, though
 * never past this cap.
 */
export const INSTRUCTIONS_CAP = 4_096;

/** The one-line marker that replaces everything past the preamble cap. */
export const PREAMBLE_TRUNCATION_MARKER = `[preamble truncated at ${PREAMBLE_CAP.toLocaleString('en-US')} characters; shorten ${PREAMBLE_FILE}]`;

export interface ComposedAgentInstructions {
  /** The platform opening, then the preamble body when there is one. Sent on the initialize handshake. */
  instructions: string;
  /**
   * The platform-owned text alone (see {@link platformInstructions}), so a
   * card can show the fixed part apart from the admin's.
   */
  header: string;
  /** The preamble body as sent (cut and marked when over the cap); empty when there is none. */
  preamble: string;
  /** The fixed first line of the prefix, so a card can show which part of it the admin owns. */
  toolPrefixLine: string;
  /** The fixed line, then the preamble's first non-heading paragraph. Prepended to the four tools' descriptions. */
  toolPrefix: string;
  /** The preamble exceeded {@link PREAMBLE_CAP} and was cut, marker appended. */
  truncated: boolean;
  /** Length of the stripped preamble BEFORE the cut, so a card can show `N / 1,800`. */
  preambleChars: number;
  /** The prefix exceeded {@link TOOL_PREFIX_CAP} and was cut. */
  toolPrefixTruncated: boolean;
  /** Length of the prefix BEFORE the cut, so a card can show `N / 300`. */
  toolPrefixChars: number;
  /** The file has a `<!--` with no `-->`: everything from it to the end was withheld. */
  unterminatedComment: boolean;
}

/**
 * Compose the two texts from the raw file content (`null` when the file is
 * absent). HTML comments are private notes and never leave the file; an
 * unterminated `<!--` strips everything after it, so the most likely editing
 * slip withholds text rather than leaking it.
 *
 * `defaultBranch` is the branch the opening names as the one people read
 * (`KbContext.defaultBranch`, read when composing). Without one — a caller
 * with no knowledge base in hand, or a deployment not yet set up — it names
 * no branch.
 */
export function composeAgentInstructions(preamble: string | null, defaultBranch = ''): ComposedAgentInstructions {
  const platform = platformInstructions(defaultBranch);
  const { text, unterminated } = stripHtmlComments(preamble ?? '');
  const normalized = text.replace(/\r\n?/g, '\n');
  const stripped = normalized.trim();
  const preambleChars = stripped.length;
  const truncated = preambleChars > PREAMBLE_CAP;
  const body = truncated ? `${cutAtCodePoint(stripped, PREAMBLE_CAP)}\n${PREAMBLE_TRUNCATION_MARKER}` : stripped;
  const instructions = body ? `${platform}\n\n${body}` : platform;

  // Classified UNTRIMMED: the leading indentation of a first line is what
  // makes it an indented code block, and the trim above would turn that
  // code into prose. The paragraph itself comes back trimmed.
  const paragraph = firstNonHeadingParagraph(normalized);
  const fullPrefix = paragraph ? `${TOOL_PREFIX_LINE} ${paragraph}` : TOOL_PREFIX_LINE;
  const toolPrefixChars = fullPrefix.length;
  const toolPrefixTruncated = toolPrefixChars > TOOL_PREFIX_CAP;
  const toolPrefix = toolPrefixTruncated ? cutAtCodePoint(fullPrefix, TOOL_PREFIX_CAP) : fullPrefix;

  return {
    instructions,
    header: platform,
    preamble: body,
    toolPrefix,
    toolPrefixLine: TOOL_PREFIX_LINE,
    truncated,
    preambleChars,
    toolPrefixTruncated,
    toolPrefixChars,
    unterminatedComment: unterminated,
  };
}

/**
 * A tool description with the prefix ahead of it: the prefix, a blank line,
 * then the original. Purpose line first, because claude.ai cuts descriptions
 * near 500 characters.
 *
 * Except for the `Call:` line, which stays the very first line whatever else
 * is prepended: it is how an agent learns the shape this tool's arguments take,
 * and a description that opens with the purpose prefix instead would bury the
 * one line the refusal for a wrong call points back to.
 */
export function prefixToolDescription(toolPrefix: string, description: string | undefined): string {
  if (!description) return toolPrefix;
  const { call, rest } = splitCallLine(description);
  if (call === null) return `${toolPrefix}\n\n${description}`;
  return rest === '' ? `${call}\n\n${toolPrefix}` : `${call}\n\n${toolPrefix}\n\n${rest}`;
}

/** An ATX heading line: `#` to `######`, then a space or the end. */
const ATX_HEADING = /^#{1,6}(\s|$)/;
/** The underline of a setext heading: a run of `=` or `-` on its own line. */
const SETEXT_UNDERLINE = /^(=+|-+)$/;
/** A thematic break: three or more `-`, `*` or `_`, optionally spaced. */
const THEMATIC_BREAK = /^([-*_])(\s*\1){2,}$/;
/** The opener of a fenced code block: three or more backticks or tildes, then an optional info string. */
const CODE_FENCE = /^(`{3,}|~{3,})/;
/** A list item or a blockquote line: a setext underline cannot be a lazy continuation of either. */
const LIST_ITEM_OR_QUOTE = /^([-*+]|\d{1,9}[.)])(\s|$)|^>/;

/**
 * The first paragraph that is not a markdown heading, collapsed to one line.
 * Blocks are separated by blank lines and by code, fenced or indented; code
 * is never a paragraph, so a fence and everything inside it (blank lines
 * and rules included) are skipped, a fence that never closes runs to the
 * end of the text, and an indented block is skipped line by line — all as
 * in CommonMark (see `paragraphBlocks`). Inside a block, ATX heading lines and
 * rules (a thematic break, or a bare `===` or `---` line) are never content,
 * and a setext heading (paragraph text with a `===` or `---` underline
 * directly beneath it) is dropped together with its underline, so
 * `Title\n===\nText` and `## Title\nText` both yield `Text`. A rule beneath
 * a list item or a blockquote, or beneath the lines that continue one, is
 * not an underline (it cannot lazily continue either), so `- Item\n---`
 * keeps the item and drops the rule. Empty when the text has no such
 * paragraph (absent, empty, code-only or heading-only preamble).
 */
function firstNonHeadingParagraph(text: string): string {
  for (const block of paragraphBlocks(text)) {
    const kinds = block.map((l) => l.kind);
    // A list item or blockquote owns every line beneath it until the block
    // ends (a lazy continuation is trimmed to look like paragraph text), so
    // once one opens, no rule further down the block is an underline.
    let container = false;
    let underline = -1;
    kinds.forEach((kind, i) => {
      if (kind === 'container') container = true;
      else if (kind === 'rule' && i > 0 && !container && kinds[i - 1] === 'text' && SETEXT_UNDERLINE.test(block[i].text))
        underline = i;
    });
    const content = block.filter((l, i) => i > underline && (l.kind === 'text' || l.kind === 'container'));
    if (content.length > 0) return content.map((l) => l.text).join(' ').replace(/\s+/g, ' ');
  }
  return '';
}

type LineKind = 'heading' | 'rule' | 'container' | 'text';

/** A block's line: its trimmed text and what it is, decided where it was read (see `paragraphBlocks`). */
interface BlockLine {
  text: string;
  kind: LineKind;
}

/**
 * What a line is on its own, in CommonMark's order of precedence: a rule is
 * tested before a list item because `- - -` and `* * *` are breaks, not
 * items. Whether a rule underlines the text above it depends on its
 * neighbours and is decided by the caller.
 */
function lineKind(line: string): LineKind {
  if (ATX_HEADING.test(line)) return 'heading';
  if (THEMATIC_BREAK.test(line) || SETEXT_UNDERLINE.test(line)) return 'rule';
  if (LIST_ITEM_OR_QUOTE.test(line)) return 'container';
  return 'text';
}

/**
 * The text's blocks outside code, each a list of trimmed non-blank lines.
 *
 * Indentation decides what is code, as in CommonMark: a fence opens or
 * closes only when indented at most three columns, and a line indented
 * four or more where no paragraph is open — at the start of a block, or
 * right after a heading or a rule, which end whatever came before them —
 * is an indented code block: literal text, so a ``` in it is content, not
 * a fence that would swallow the rest of the file. Under paragraph text
 * (a list item or blockquote included) the same indentation is a
 * continuation, since indented code cannot interrupt a paragraph — and a
 * continuation is paragraph TEXT whatever it says once trimmed: `    # x`
 * under a line of prose is not a heading and `    ---` is not a rule, so
 * each line's kind is decided here, with its indentation in hand, and
 * carried with it.
 */
function paragraphBlocks(text: string): BlockLine[][] {
  const blocks: BlockLine[][] = [];
  let block: BlockLine[] = [];
  let fence: string | null = null; // the opener of the fenced code block being skipped
  const flush = () => {
    if (block.length > 0) blocks.push(block);
    block = [];
  };
  const paragraphOpen = () => {
    const last = block[block.length - 1];
    return last !== undefined && (last.kind === 'text' || last.kind === 'container');
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const indent = indentColumns(raw);
    if (fence !== null) {
      // The closer: the opener's character only, at least as many of it, nothing else.
      if (indent <= 3 && line.startsWith(fence) && /^(`+|~+)$/.test(line)) fence = null;
      continue;
    }
    const opener = indent <= 3 ? CODE_FENCE.exec(line) : null;
    if (opener) {
      flush();
      fence = opener[1];
    } else if (line.length === 0) {
      flush();
    } else if (indent >= 4) {
      // Indented code, skipped line by line (blank lines between flush
      // nothing) — or, under an open paragraph, a continuation of it.
      if (paragraphOpen()) block.push({ text: line, kind: 'text' });
    } else {
      block.push({ text: line, kind: lineKind(line) });
    }
  }
  flush();
  return blocks;
}

/** Leading indentation in columns, a tab reaching the next multiple of four. */
function indentColumns(raw: string): number {
  let columns = 0;
  for (const ch of raw) {
    if (ch === ' ') columns += 1;
    else if (ch === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: a
 * high surrogate at the cut moves the cut before it, so no broken character
 * is ever sent and the count in the card matches what the server sends.
 */
function cutAtCodePoint(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}
