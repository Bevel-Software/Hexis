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
  /**
   * Where the snippet goes, said as the path through that client's own UI. A
   * list renders as numbered steps — for a path with enough turns that one
   * sentence of arrows loses people halfway.
   */
  hint: string | string[];
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
    // ChatGPT renamed the page under our feet: as of 2026-09 it is Plugins
    // (Plugin Management, Browse plugins, Developer Mode), where it used to be
    // Apps & Connectors with Developer mode under Advanced. Each step names
    // both, so whichever build someone is on, the words on their screen are in
    // the steps. Developer Mode comes before Create because it is off by
    // default and hides that button. The name is spelled out because, unlike
    // Claude, ChatGPT has no link that prefills it.
    hint: [
      'Open Settings in ChatGPT.',
      'Open Plugins (called Apps & Connectors in older versions).',
      'Turn on Developer Mode (under Advanced in older versions).',
      'Go back and choose Create (or Add).',
      `Name it “${MCP_DISPLAY_NAME}”.`,
      'Paste the address below, then save.',
    ],
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
    label: 'Other tools',
    // What to DO with the config, not what kind of client reads it: the reader
    // is a business user for whom "a JSON config" says nothing. The page puts
    // the bare address right after this, because plenty of tools take a URL
    // and nothing else.
    hint: 'For any other AI tool that supports MCP servers. Open the tool’s settings, find MCP servers (also called connectors or integrations), choose add, and paste this configuration. If the tool asks for an address only, paste this instead:',
    snip: (url) => jsonConfigSnippet(url),
  },
];
