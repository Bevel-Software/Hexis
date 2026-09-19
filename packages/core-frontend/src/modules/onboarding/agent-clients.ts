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
    // The PATH sentence is the second half of this hint because it is the
    // failure people actually hit. A GUI-launched app — Cursor, or Claude
    // Desktop on macOS — is started by the window server rather than by a
    // login shell, so it never sources the profile that put Homebrew's or
    // nvm's `npx` on PATH: the configuration is correct and the client still
    // reports that npx was not found. The way out is a substitution the
    // READER makes in their own copy, which is why the snippet itself stays
    // the plain `npx` that works everywhere else. The absolute path alone is
    // not always enough: `npx` is a script whose `#!/usr/bin/env node` line
    // hits the SAME gap, so the PATH sentence has to name that second failure
    // and its fix (the client config's own "env") rather than stop at the
    // first.
    hint: 'For Claude Code, Claude Desktop, Cursor, Windsurf, Cline and any agent that runs on your machine: everything the hosted address gives, plus your plugins’ local-only tools. Needs Node 22.13+ or 24. The first time it starts, your browser opens so you can sign in. If the client reports that npx was not found, it was launched from the Dock or a desktop icon and cannot see your shell’s PATH — run `which npx` in a terminal (`where npx` in PowerShell) and put the full path it prints in place of "npx" in the configuration below; if it then reports `env: node: No such file or directory`, that folder holds `node` too, so add it to the configuration’s "env" PATH.',
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
