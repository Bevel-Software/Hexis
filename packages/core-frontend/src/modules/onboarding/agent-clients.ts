import { hexisMcpJsonSnippet, jsonConfigSnippet, workspaceBaseUrl } from '../../shared/mcp';

/**
 * The ways an agent connects, named by PRODUCT rather than surface —
 * someone knows which assistant they use before they know which build of it
 * they are in (prototype `AGENT_CLIENTS`). The one exception is "Local
 * tools", which is named by NEED: it is the same clients as the others, run
 * against the local hexis-mcp server instead, and the thing someone knows
 * when they want it is which tools stopped short — not which server binary
 * fixes that.
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
    id: 'claude',
    label: 'Claude',
    hint: 'claude.ai or Claude Desktop: Settings → Connectors → Add custom connector, then paste this. In Claude Code, `claude mcp add` takes the same URL.',
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
    label: 'Cursor & Others',
    hint: 'For clients that read their servers from a JSON config, like Cursor, Windsurf and Cline.',
    snip: (url) => jsonConfigSnippet(url),
  },
  {
    id: 'local',
    label: 'Local tools',
    hint: 'Runs on your machine, so plugins’ local-only tools work. Needs Node. Replace the key placeholder with an external API key from the profile menu → External agent access.',
    // The passed endpoint is deliberately unused: the local server takes the
    // WORKSPACE address and asks it for the MCP endpoint itself
    // (`GET /api/config`), so the URL every other client pastes is the wrong
    // value here — see `workspaceBaseUrl`.
    snip: () => hexisMcpJsonSnippet(workspaceBaseUrl()),
  },
];
