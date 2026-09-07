/**
 * What a connected agent is told at the start of an MCP session, composed
 * from two layers: a platform header the code owns, and the deployment
 * preamble an admin writes in `mcp-description.md` at the repository root.
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

/** The repository-root file an admin edits. */
export const PREAMBLE_FILE = 'mcp-description.md';

/** UTF-16 units of preamble sent on the handshake before the marker replaces the rest. */
export const PREAMBLE_CAP = 6_000;

/** UTF-16 units of the whole tool prefix (fixed line included). */
export const TOOL_PREFIX_CAP = 300;

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
  'Skills are available as prompts and through `list_skills` and `get_skill`.';

/**
 * The fixed first line of the tool prefix. It always leads, so an admin's
 * first edit never removes the instruction from the clients that only see
 * tool descriptions, and a preamble that opens with a heading still yields a
 * sensible purpose line.
 */
export const TOOL_PREFIX_LINE = "This organisation's knowledge base. Search it before answering from memory.";

/** The one-line marker that replaces everything past the preamble cap. */
export const PREAMBLE_TRUNCATION_MARKER = `[preamble truncated at ${PREAMBLE_CAP.toLocaleString('en-US')} characters; shorten ${PREAMBLE_FILE}]`;

export interface ComposedAgentInstructions {
  /** The header, then the preamble body when there is one. Sent on the initialize handshake. */
  instructions: string;
  /** The platform header alone, so a card can show the fixed part apart from the admin's. */
  header: string;
  /** The preamble body as sent (cut and marked when over the cap); empty when there is none. */
  preamble: string;
  /** The fixed first line of the prefix, so a card can show which part of it the admin owns. */
  toolPrefixLine: string;
  /** The fixed line, then the preamble's first non-heading paragraph. Prepended to the four tools' descriptions. */
  toolPrefix: string;
  /** The preamble exceeded {@link PREAMBLE_CAP} and was cut, marker appended. */
  truncated: boolean;
  /** Length of the stripped preamble BEFORE the cut, so a card can show `N / 6,000`. */
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
 */
export function composeAgentInstructions(preamble: string | null): ComposedAgentInstructions {
  const { text, unterminated } = stripHtmlComments(preamble ?? '');
  const stripped = text.replace(/\r\n?/g, '\n').trim();
  const preambleChars = stripped.length;
  const truncated = preambleChars > PREAMBLE_CAP;
  const body = truncated ? `${cutAtCodePoint(stripped, PREAMBLE_CAP)}\n${PREAMBLE_TRUNCATION_MARKER}` : stripped;
  const instructions = body ? `${PLATFORM_HEADER}\n\n${body}` : PLATFORM_HEADER;

  const paragraph = firstNonHeadingParagraph(stripped);
  const fullPrefix = paragraph ? `${TOOL_PREFIX_LINE} ${paragraph}` : TOOL_PREFIX_LINE;
  const toolPrefixChars = fullPrefix.length;
  const toolPrefixTruncated = toolPrefixChars > TOOL_PREFIX_CAP;
  const toolPrefix = toolPrefixTruncated ? cutAtCodePoint(fullPrefix, TOOL_PREFIX_CAP) : fullPrefix;

  return {
    instructions,
    header: PLATFORM_HEADER,
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
 */
export function prefixToolDescription(toolPrefix: string, description: string | undefined): string {
  return description ? `${toolPrefix}\n\n${description}` : toolPrefix;
}

/**
 * Remove every `<!-- … -->` block. A `<!--` that is never closed takes the
 * rest of the text with it and is reported, so the card can warn.
 */
function stripHtmlComments(text: string): { text: string; unterminated: boolean } {
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf('<!--', from);
    if (open === -1) {
      out += text.slice(from);
      return { text: out, unterminated: false };
    }
    out += text.slice(from, open);
    const close = text.indexOf('-->', open + 4);
    if (close === -1) return { text: out, unterminated: true };
    from = close + 3;
  }
}

/** An ATX heading line: `#` to `######`, then a space or the end. */
const ATX_HEADING = /^#{1,6}(\s|$)/;
/** The underline of a setext heading: a run of `=` or `-` on its own line. */
const SETEXT_UNDERLINE = /^(=+|-+)$/;
/** A thematic break: three or more `-`, `*` or `_`, optionally spaced. */
const THEMATIC_BREAK = /^([-*_])(\s*\1){2,}$/;

/**
 * The first paragraph that is not a markdown heading, collapsed to one line.
 * Blocks are separated by blank lines. Inside a block, ATX heading lines and
 * thematic breaks are dropped, and a setext heading (text with a `===` or
 * `---` underline directly beneath it) is dropped together with its
 * underline, so `Title\n===\nText` and `## Title\nText` both yield `Text`.
 * Empty when the text has no such paragraph (absent, empty or heading-only
 * preamble).
 */
function firstNonHeadingParagraph(text: string): string {
  for (const block of text.split(/\n[ \t]*\n/)) {
    let lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    // A setext underline heads everything above it; keep only what follows
    // the last one, since a block may open with `Title\n---` and go on.
    const underline = lines.reduce((last, l, i) => (i > 0 && SETEXT_UNDERLINE.test(l) ? i : last), -1);
    if (underline >= 0) lines = lines.slice(underline + 1);
    const content = lines.filter((l) => !ATX_HEADING.test(l) && !THEMATIC_BREAK.test(l));
    if (content.length > 0) return content.join(' ').replace(/\s+/g, ' ');
  }
  return '';
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
