/**
 * How much each layer of what an agent is told may cost, in tokens.
 *
 * Three layers (openspec/changes/agent-guide-layers/design.md): what every
 * connection carries (the handshake instructions and the tool list), what an
 * agent reads on first contact (the start section `get_agent_guide` answers
 * with), and what it fetches only when a task needs it (every other section).
 * A line in the first layer costs every conversation and every sub-agent; a
 * line in the last costs only the tasks that fetch it. The budgets are what
 * keeps the guide from growing into a document every agent loads whole and
 * reads little of, which is what a customer's agent did fifteen times in one
 * day.
 *
 * Counted with the `o200k_base` encoding by `__tests__/guide-budget.test.ts`.
 * It is a real tokenizer that runs offline; it is not Claude's own, which
 * usually counts somewhat more for the same text, so these are ceilings to
 * compare against each other and over time rather than a model's bill.
 *
 * Every number is one a reviewer may move. The point of pinning them is that
 * growing the guide is a decision someone takes, not a paragraph someone
 * appends: a section that needs more room says why in the pull request that
 * raises its line here.
 */

/** The encoding the budgets are counted in. */
export const GUIDE_TOKEN_ENCODING = 'o200k_base';

/** The platform's part of the handshake instructions: the header and the shared file rules. */
export const INSTRUCTIONS_TOKEN_BUDGET = 2_000;

/**
 * The platform's own tools as the hosted endpoint lists them to an MCP client:
 * each name, description (with its `Call:` line and, on the four
 * knowledge-base tools, the purpose prefix) and input schema.
 */
export const TOOL_LIST_TOKEN_BUDGET = 16_000;

/** The ceiling for a section a distribution adds, which core's checks cannot see: the same as core's own. */
export const SECTION_TOKEN_BUDGET = 2_500;

/**
 * Each core section's budget, by id. A section without a line here fails the
 * budget test: a new section starts by saying what it may cost.
 */
export const SECTION_TOKEN_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  'start-here': 1_200,
  'how-agents-find-things': SECTION_TOKEN_BUDGET,
  'for-git-users': SECTION_TOKEN_BUDGET,
  glossary: SECTION_TOKEN_BUDGET,
  'directory-structure': SECTION_TOKEN_BUDGET,
  'where-a-new-file-goes': SECTION_TOKEN_BUDGET,
  'working-with-files': SECTION_TOKEN_BUDGET,
  'access-control': SECTION_TOKEN_BUDGET,
  'drafts-and-change-requests': SECTION_TOKEN_BUDGET,
  skills: SECTION_TOKEN_BUDGET,
  tools: SECTION_TOKEN_BUDGET,
  'tool-manuals': SECTION_TOKEN_BUDGET,
  // The page contract is long by nature (the frame, the bridge, the link
  // rules, pages that load live data), and an agent fetches it only to build
  // a page.
  'html-views': 5_500,
  conventions: SECTION_TOKEN_BUDGET,
  'new-knowledge-base': SECTION_TOKEN_BUDGET,
});

/** Every core section at once: what `section: "all"` returns. */
export const WHOLE_GUIDE_TOKEN_BUDGET = 21_500;

/** One task: the start section plus the sections it routes the task to. */
export const TASK_TOKEN_BUDGET = 6_000;
