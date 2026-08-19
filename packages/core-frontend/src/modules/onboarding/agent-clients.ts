import { hexisMcpJsonSnippet, jsonConfigSnippet, workspaceBaseUrl } from '../../shared/mcp';

/**
 * The ways an agent connects, named by PRODUCT rather than surface —
 * someone knows which assistant they use before they know which build of it
 * they are in (prototype `AGENT_CLIENTS`). The one exception is the first
 * entry: the LOCAL server leads, because it is the recommended connection for
 * every desktop agent — it serves everything the hosted endpoint does PLUS
 * the plugins' local-only tools — and the entries after it exist for the
 * agents that cannot run a local process (web assistants, cloud platforms).
 *
 * This file is now the welcome page's PICKER and nothing else: which clients
 * to offer, what to call them, and how to say where the snippet goes. The
 * snippets themselves, and the endpoint they are built from, live in
 * `shared/mcp` — which is what makes the welcome page and the External agent
 * access page agree.
 *
 * They did not, before. The docstring here used to claim the two surfaces
 * "can never hand out different URLs" because the settings page derived the
 * endpoint "exactly as" this file did. It never imported this file. It
 * hand-built the same address in six places, and the two agreed by convention
 * rather than by construction — which held only as long as nobody edited
 * either one.
 */

export interface AgentClient {
  id: 'claude' | 'chatgpt' | 'other' | 'local';
  label: string;
  /** Where the snippet goes, said as the path through that client's own UI. */
  hint: string;
  /** What the copy button carries for this client. */
  snip(mcpUrl: string): string;
}

export const AGENT_CLIENTS: AgentClient[] = [
  {
    id: 'local',
    label: 'Desktop agents',
    hint: 'Recommended for Claude Code, Claude Desktop, Cursor, Windsurf, Cline and any agent that runs on your machine: everything the options below give, plus your plugins’ local-only tools. Needs Node. Replace the key placeholder with an external API key from the profile menu → External agent access.',
    // The passed endpoint is deliberately unused: the local server takes the
    // WORKSPACE address and asks it for the MCP endpoint itself
    // (`GET /api/config`), so the URL every other client pastes is the wrong
    // value here — see `workspaceBaseUrl`.
    snip: () => hexisMcpJsonSnippet(workspaceBaseUrl()),
  },
  {
    id: 'claude',
    label: 'Claude',
    hint: 'For claude.ai on the web: Settings → Connectors → Add custom connector, then paste this. (On your own machine, Desktop agents is the better connection.)',
    snip: (url) => url,
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    // Developer mode first: it is off by default, and every "Create" button
    // someone hunts for is behind it.
    hint: 'Settings → Apps & Connectors → Advanced → turn on Developer mode, then Create and paste this.',
    snip: (url) => url,
  },
  {
    id: 'other',
    label: 'Other',
    hint: 'For web and cloud clients that read their servers from a JSON config but can’t run a local process.',
    snip: (url) => jsonConfigSnippet(url),
  },
];
