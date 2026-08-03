/**
 * The three ways an agent connects, named by PRODUCT rather than surface —
 * someone knows which assistant they use before they know which build of it
 * they are in (prototype `AGENT_CLIENTS`).
 *
 * The endpoint is derived from the page's own origin, exactly as the
 * External agent access page derives it (`ExternalAgentAccessPage.tsx`), so
 * the welcome page and the settings page can never hand out different URLs.
 * Passed in rather than read from `window` here, so tests can pin it.
 */

export interface AgentClient {
  id: 'claude' | 'chatgpt' | 'other';
  label: string;
  /** Where the snippet goes, said as the path through that client's own UI. */
  hint: string;
  /** What the copy button carries for this client. */
  snip(mcpUrl: string): string;
}

export const AGENT_CLIENTS: AgentClient[] = [
  {
    id: 'claude',
    label: 'Claude',
    hint: 'claude.ai or Claude Desktop: Settings → Connectors → Add custom connector, then paste this. In Claude Code, `claude mcp add` takes the same URL.',
    snip: (url) => url,
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    hint: 'Settings → Connectors → Create, then paste this.',
    snip: (url) => url,
  },
  {
    id: 'other',
    label: 'Cursor & Others',
    hint: 'For clients that read their servers from a JSON config — Cursor, Windsurf, Cline.',
    snip: (url) =>
      JSON.stringify({ mcpServers: { 'knowledge-base': { type: 'http', url } } }, null, 2),
  },
];

/**
 * The MCP endpoint for a given page origin — the one URL every snippet above
 * is built from. Derived rather than configured, so a deployment on any host
 * hands out its own address without anyone remembering to update a constant.
 */
export const mcpUrlFromOrigin = (origin: string): string => `${origin}/api/mcp`;
