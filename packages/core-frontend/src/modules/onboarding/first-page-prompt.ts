/**
 * The one-click first prompt behind "Write your first page": a request a
 * connected agent can act on straight away, and the links that open it in a
 * new chat already typed.
 *
 * Short on purpose. It travels in a URL, and a page about the company is the
 * one every knowledge base needs and every new person can answer for — the
 * agent asks for what it cannot find rather than inventing it.
 */
export const FIRST_PAGE_PROMPT =
  "Using our Hexis knowledge base, write a page in Knowledge about our company: what we do, who we work with, and our main products. Ask me for anything you don't know, then save it.";

/**
 * The request for the team that answered "What does your team do?": its
 * starter pack's own (`firstPagePrompt` — for Sales, "fill in the Customers
 * page…"), else the generic one above. Trimmed: a pack writes it as a YAML
 * block, which ends in a newline nobody wants in a URL.
 */
export function firstPagePromptFor(pack: { firstPagePrompt: string } | null | undefined): string {
  return pack?.firstPagePrompt.trim() || FIRST_PAGE_PROMPT;
}

/** A new Claude chat with `prompt` typed into it (claude.ai's `q` parameter prefills; the person still sends). */
export function claudePromptUrl(prompt: string): string {
  return `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;
}

/** The same for ChatGPT, whose `q` parameter prefills a new chat. */
export function chatGptPromptUrl(prompt: string): string {
  return `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`;
}

/**
 * Which of the prompt's ways in leads, for the agent that connected.
 *
 *  - `claude`: the claude.ai link. Only for a connection claude.ai or Claude
 *    Desktop made with the hosted address — a custom connector added there is
 *    on both, so a new chat at claude.ai can reach the knowledge base.
 *  - `chatgpt`: the chatgpt.com link, for ChatGPT's connector.
 *  - `copy`: the prompt itself, for everything else — Claude Code, Cursor,
 *    any agent on the local server, any connection key, a name we do not
 *    know. None of them can be opened from a link, and pointing someone at a
 *    web chat that cannot see their knowledge base is a dead end.
 */
export type FirstPagePrimary = 'claude' | 'chatgpt' | 'copy';

export interface FirstPageRoute {
  primary: FirstPagePrimary;
  /**
   * The agent as a person names it, for "Paste it into …": the part before
   * the local server's " · local server on <machine>", and null when the
   * server only knows it as an unnamed or unknown agent — or by a connection
   * key's label, which names the key rather than the app holding it.
   */
  agentName: string | null;
}

/** The local server registers as "<agent> · local server on <machine>" (`hexis-mcp` `registrationName`). */
const LOCAL_SERVER_SUFFIX = /\s*·\s*local server on\b.*$/i;

/** What claude.ai and Claude Desktop call themselves, folded. "Claude Code" is deliberately absent. */
const CLAUDE_WEB_NAMES = new Set(['claude', 'claude.ai', 'claude-ai', 'claude ai', 'claude desktop', 'claude-desktop']);

/**
 * Reads the connection answer's `client` into the step's leading action.
 * Only an OAuth connection's (`kind: 'agent'`) name is the app's own: a
 * connection key's label is whatever its owner typed, so a key called
 * "ChatGPT CLI" says nothing about ChatGPT being able to use it, and a key —
 * or an answer that does not say which it is — always leads with `copy`.
 * Case-insensitive, and anything it does not recognise falls back to `copy`,
 * which works with every agent.
 */
export function firstPageRoute(
  client: string | null | undefined,
  kind: 'agent' | 'key' | null | undefined,
): FirstPageRoute {
  if (kind !== 'agent') return { primary: 'copy', agentName: null };
  const raw = (client ?? '').trim();
  const local = LOCAL_SERVER_SUFFIX.test(raw);
  const name = raw.replace(LOCAL_SERVER_SUFFIX, '').trim();
  const folded = name.toLowerCase();
  const agentName = !name || /^(unnamed|unknown) agent$/i.test(name) ? null : name;
  // A local-server connection lives in that app's config file, not in the
  // web chat a link would open — even when the app is Claude Desktop.
  if (local) return { primary: 'copy', agentName };
  if (/\bchatgpt\b/.test(folded)) return { primary: 'chatgpt', agentName };
  if (CLAUDE_WEB_NAMES.has(folded)) return { primary: 'claude', agentName };
  return { primary: 'copy', agentName };
}
