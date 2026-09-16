import {
  MCP_DISPLAY_NAME,
  hexisMcpJsonSnippet,
  jsonConfigSnippet,
  workspaceBaseUrl,
} from '../../shared/mcp';

/**
 * The ways an agent connects, named by PRODUCT rather than surface —
 * someone knows which assistant they use before they know which build of it
 * they are in (prototype `AGENT_CLIENTS`). Claude and ChatGPT lead, and
 * Claude is the page's default: they are what most people arriving here
 * already use, and Claude's is the one connection that is a single click.
 * Desktop agents follow — the local server still serves everything the hosted
 * endpoint does PLUS the plugins' local-only tools, but it asks for Node and a
 * config file, which is the wrong first thing to put in front of everyone.
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
    hint: 'For claude.ai and Claude Desktop: Settings → Connectors → Add custom connector, then paste this. (For your plugins’ local-only tools, pick Desktop agents.)',
    snip: (url) => url,
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    // Developer mode first: it is off by default, and every "Create" button
    // someone hunts for is behind it. The name is spelled out because, unlike
    // Claude, ChatGPT has no link that prefills it.
    hint: `Settings → Apps & Connectors → Advanced → turn on Developer mode, then Create: name it “${MCP_DISPLAY_NAME}” and paste this.`,
    snip: (url) => url,
  },
  {
    id: 'local',
    label: 'Desktop agents',
    hint: 'For Claude Code, Claude Desktop, Cursor, Windsurf, Cline and any agent that runs on your machine: everything the hosted address gives, plus your plugins’ local-only tools. Needs Node. The first time it starts, your browser opens so you can sign in.',
    // The passed endpoint is deliberately unused: the local server takes the
    // WORKSPACE address and asks it for the MCP endpoint itself
    // (`GET /api/config`), so the URL every other client pastes is the wrong
    // value here — see `workspaceBaseUrl`.
    snip: () => hexisMcpJsonSnippet(workspaceBaseUrl()),
  },
  {
    id: 'other',
    label: 'Other',
    hint: 'For web and cloud clients that read their servers from a JSON config but can’t run a local process.',
    snip: (url) => jsonConfigSnippet(url),
  },
];
