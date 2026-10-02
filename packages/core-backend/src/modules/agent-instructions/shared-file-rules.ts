/**
 * The rules that apply to MORE THAN ONE file tool, written ONCE.
 *
 * They used to be appended, in full, to every tool description that they
 * covered: the content rule rode on all twelve file tools, the agent-guide
 * reminder on all of them plus the shell, the write-mode and escape-sequence
 * paragraphs on two or three apiece. A description then ran to two or three
 * thousand characters, most of it text the agent had already read on the tool
 * above — and clients cut long descriptions from the END, which is where the
 * text specific to the tool sits. Agents saw `file_stat`, `read_file`,
 * `write_file` and `write_files` arrive ending in "[truncated]".
 *
 * So the shared rules are stated in TWO places and in neither description:
 *
 *  - the MCP `instructions` of the initialize handshake (see `compose.ts`),
 *    which Claude Code, Claude Desktop and Cursor put in the system prompt;
 *  - the platform-managed agent guide at the repository root (`AGENTS.md` by
 *    default), rendered from `{{sharedFileRules}}` in the template — claude.ai
 *    on the web, the Agent SDK and Cline drop `instructions`, and a guide the
 *    agent is told to read before its first action is always available.
 *
 * Both places get the SAME string, from {@link sharedFileRulesSection} — not
 * two hand-mirrored copies. A rule written twice is a rule that drifts, and a
 * drifted rule is worse than a repeated one, because the agent cannot tell
 * which copy is current. Each description ends instead with
 * {@link sharedRulesPointer}, one sentence naming the section and the file.
 *
 * Pure text, a function of the layout only: the guide's file name is a
 * deployment setting, so nothing here may snapshot `AGENTS.md`.
 */

import {
  DEFAULT_KB_LAYOUT,
  agentsFileOf,
  LEGACY_AGENTS_FILE,
  platformFilesByDepth,
  type KbLayout,
} from '@bevel-software/platform-shared';

/** The heading the rules live under, in both places and in the pointer sentence. */
export const SHARED_RULES_SECTION = 'Working with files';

/**
 * The guide's name on a knowledge base seeded before it was renamed to
 * {@link LEGACY_AGENTS_FILE}. Named in the conventions rule because the seeder
 * never deletes a file it did not expect, so such a knowledge base still
 * carries one.
 */
const PRE_RENAME_AGENTS_FILE = 'CLAUDE.md';

/**
 * The ceiling on the whole section. Pinned by a test: the section lands in
 * every conversation through two channels, and a rule moved here to shorten a
 * description has only moved the cost if the section itself grows without
 * limit. Measured against {@link sharedFileRulesSection} under the default
 * layout.
 */
export const SHARED_FILE_RULES_CAP = 6_000;

/** One shared rule: how the guide heads it, and the rule itself. */
export interface SharedFileRule {
  /** Stable id, so a test can name the rule that went missing. */
  id: string;
  /** The heading this rule gets in the section. */
  heading: string;
  /** The rule, as both places state it. Markdown paragraphs, blank-line separated. */
  body: string;
}

/**
 * Every shared rule, in reading order: what to read first, what the content
 * is, what a write may do, then the two protocols that guard a destructive
 * call.
 *
 * The bodies are the sentences the descriptions used to carry, moved rather
 * than rewritten wherever the wording still reads outside its old tool — the
 * ones that said "this tool" or "this call" name the tools instead.
 */
export function sharedFileRules(layout: KbLayout): readonly SharedFileRule[] {
  const agentsFile = agentsFileOf(layout);
  return [
    {
      id: 'agent-guide',
      heading: "This knowledge base's own conventions",
      body: conventionsRule(agentsFile),
    },
    {
      id: 'content-kinds',
      heading: 'Text, documents, images and other binaries',
      body:
        'read_file returns text for text files and extracted text for documents ' +
        '(.docx/.pptx/.xlsx/.odt/.odp/.ods/.pdf, .eml/.msg); write_file, write_files and edit_file accept TEXT only — ' +
        'they refuse documents, images, archives and other binary files (legacy .doc/.ppt/.xls included) with kind ' +
        "`binary_not_writable`, naming the file's kind and the tool to use instead; copy_file, move_file and delete_file " +
        'act on bytes of any kind and unzip extracts the entries of a `.zip`; new binary content arrives through ' +
        'upload (`request_upload_token` + ' +
        '`apply_upload` where offered, otherwise Upload in the app). file_stat reports `contentMode` ' +
        '(`text` | `document` | `binary`) so you can decide before acting.\n\n' +
        'Office and OpenDocument files (.docx/.pptx/.xlsx, .odt/.odp/.ods) and PDFs read as EXTRACTED text under an ' +
        'honest `[extracted text of …]` header, with `[slide N]`/`[sheet: Name]`/`[page N]` markers — the extraction ' +
        'is READ-ONLY (layout/images omitted; such files cannot be edited as text, only replaced by uploading a new ' +
        'version). Email files (.eml/.msg) read the same way: a `[from]`/`[to]`/`[subject]`/`[date]` header block, the ' +
        'body (plain-text part preferred; an HTML-only body is stripped to text), and an `[attachments]` name list — ' +
        'attachments are listed, never extracted. grep searches inside all of those, through the same extractions.\n\n' +
        'Images (.png/.jpg/.jpeg/.gif/.webp) read as the IMAGE ITSELF, as native MCP image content with a one-line ' +
        'text note naming the file, so you can look at the picture — up to 3.5 MB of raw image data; a larger image ' +
        'gets an honest refusal asking for a locally downscaled copy or a smaller export (`.svg` is text and reads as ' +
        'text). Images come back only on a DIRECT read_file: inside `call_tool_chain` an image read yields an ' +
        '`{ image_omitted, note }` stub instead, so read an image outside a chain when you mean to look at it. Any other ' +
        'binary file reads as a one-line description rather than raw bytes.',
    },
    {
      id: 'write-mode',
      heading: 'What a write may do at a path',
      body:
        'On write_file and write_files, `mode` decides what may happen at a path and DEFAULTS TO `create`: `create` ' +
        'writes a new file and refuses a path that already exists (`exists`, with the path — pass `mode: overwrite` to ' +
        'replace it), `overwrite` replaces what is there (creating it if there is nothing), `update` replaces an ' +
        'existing file and refuses a path that does not exist (`missing`). A refused path is left exactly as it was.',
    },
    {
      id: 'images-in-pages',
      heading: 'Where the images a page uses go',
      body:
        'Keep them in an `assets/` folder next to the page that uses them and link them with a relative path, e.g. ' +
        '`![Approval screen](./assets/approval-screen.png)`; the page renders them inline.',
    },
    {
      id: 'escape-sequences',
      heading: 'Escape sequences in content you send',
      body:
        'On write_file, write_files and edit_file, which take content as a JSON string: some clients decode escape ' +
        'sequences in arguments before sending, so content meant to CONTAIN an escape rather than what it stands for ' +
        '(the six characters backslash, `u`, `0`, `0`, `4`, `1`, say, rather than the letter `A`) can reach the tool ' +
        'already decoded — what arrives is stored byte for byte, so when that distinction matters, verify what landed ' +
        '(`read_file`, or a hash) and send such content through the upload route (`request_upload_token` + ' +
        '`apply_upload` where offered, otherwise Upload in the app), which lands it unchanged.',
    },
    {
      id: 'dry-run-confirm',
      heading: 'Dry-run before a move or a folder delete',
      body:
        'move_file and delete_folder take `dryRun: true`: it changes nothing and answers the impact — ' +
        'what the call would touch, `allowed`, and `reason` when it may not run. A non-empty folder is deleted, and a ' +
        'move that changes your access runs, only with `confirm: true`; without it the call changes nothing and ' +
        'returns the same impact with `confirmationRequired: true`. Do NOT set `confirm: true` on your first call — ' +
        'dry-run, check the impact, then confirm. delete_file takes neither: it removes the one file you named, so ' +
        'check it first with file_stat (`deletable`) if you are unsure.',
    },
    {
      id: 'managed-items',
      heading: 'What these tools never move or delete',
      body:
        `A platform file (${platformFileList(layout)}) is refused with ` +
        '"<name> is a platform file and stays in its folder." — a folder that moves ' +
        'takes its own platform files along, still in their folder, and a folder that is deleted takes them with it in ' +
        'the same one change, so its files are never left ungoverned part-way. A platform folder (the repository root ' +
        `or a reserved root folder such as \`${layout.knowledgeBaseDir}/\`) and git metadata are refused, and so is creating a ` +
        'platform file or folder at a destination (renaming a note to `access.md` is refused). A path that is, or goes ' +
        'through, a symbolic link is refused: links are never followed or removed. On a protected branch you must be ' +
        'able to write everything the call touches — for a folder, every file under it, at its old and its new path. ' +
        'file_stat reports `managed`, `movable` and `deletable` so you can tell before the call.',
    },
    {
      id: 'refused-for-permissions',
      heading: 'When a write is refused for permissions',
      body:
        'A refusal is not necessarily the end of the road: the `write-denied` error says whether you may propose the ' +
        'change instead (create a branch from this one, repeat the call on it, then `open_change_request` into this ' +
        'branch) and lists those steps.',
    },
  ];
}

/**
 * The platform files as the rules list them — from the one function that knows
 * which they are, so the list cannot drift from what actually refuses a move,
 * and the guide appears under this deployment's name for it.
 *
 * WITH THE DEPTH each name counts at, because the name alone is half the rule:
 * `access.md` governs the folder it sits in and `.bevelignore` layers, so both
 * are platform files wherever they are; `roles.yaml` and the guide are read
 * from the repository root only, so a nested copy of either is ordinary
 * content that moves and deletes like any page. An agent told only the names
 * refuses a rename it may make, and trusts a nested `access.md` it may not.
 */
function platformFileList(layout: KbLayout): string {
  const { anyDepth, rootOnly } = platformFilesByDepth(layout);
  const quoted = (names: readonly string[]): string => names.map((name) => `\`${name}\``).join(' or ');
  return `${quoted(anyDepth)} in any folder, ${quoted(rootOnly)} at the repository root`;
}

/**
 * The conventions reminder — which file holds the author's own rules for this
 * knowledge base, and to read it first.
 *
 * `CLAUDE.md` is named as a fallback because knowledge bases seeded before the
 * rename still carry one. WHEN THE GUIDE HAS BEEN RENAMED the sentence names
 * two files, ours first: the second is the organisation's OWN `AGENTS.md`,
 * which on such a deployment is ordinary content the platform never touches —
 * and which no harness reads for a remote agent, because a remote agent has no
 * checkout. Under the default name the wording collapses to the one file it
 * has always named.
 */
function conventionsRule(agentsFile: string): string {
  if (agentsFile === LEGACY_AGENTS_FILE) {
    return (
      `Before your first read or change in a workspace, read \`${LEGACY_AGENTS_FILE}\` at the KB root — or ` +
      `\`${PRE_RENAME_AGENTS_FILE}\` on a knowledge base seeded before it was renamed — if either exists: it holds ` +
      "the author's conventions for this knowledge base, and you should follow them."
    );
  }
  return (
    `Before your first read or change in a workspace, read \`${agentsFile}\` at the KB root, then ` +
    `\`${LEGACY_AGENTS_FILE}\` if it also exists (the organisation's own conventions) — or ` +
    `\`${PRE_RENAME_AGENTS_FILE}\` on a knowledge base seeded before it was renamed: together they hold the ` +
    'conventions for this knowledge base, and you should follow them.'
  );
}

/**
 * The shared rules as ONE markdown section — the string both channels carry,
 * byte for byte. A `##` section so it drops into the managed guide at that
 * level and still reads as a block in the instructions blob.
 */
export function sharedFileRulesSection(layout: KbLayout): string {
  const body = sharedFileRules(layout)
    .map((rule) => `### ${rule.heading}\n\n${rule.body}`)
    .join('\n\n');
  return `## ${SHARED_RULES_SECTION}\n\n${body}`;
}

/**
 * The one sentence a tool description ends with, in place of the paragraphs it
 * used to carry. Short on purpose: it costs every description the same ~80
 * characters, and its whole job is to name the section and the file to read.
 *
 * An absent layout means the default one, as it does in
 * `composeAgentInstructions`: a caller reading the layout from configuration
 * gets `undefined` when none is set, and the pointer must still name a file.
 */
export function sharedRulesPointer(layout: KbLayout = DEFAULT_KB_LAYOUT): string {
  return ` Shared rules for all file tools: see "${SHARED_RULES_SECTION}" in ${agentsFileOf(layout)}.`;
}
