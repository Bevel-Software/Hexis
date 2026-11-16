import {
  MCP_DISPLAY_NAME,
  claudeCodeCommand,
  hexisMcpClaudeCommand,
  hexisMcpJsonSnippet,
  jsonConfigSnippet,
  workspaceBaseUrl,
} from './connect-snippets';

/**
 * The ways an agent connects, named by PRODUCT rather than surface —
 * someone knows which assistant they use before they know which build of it
 * they are in (prototype `AGENT_CLIENTS`). Claude and ChatGPT lead, and
 * Claude is the page's default: they are what most people arriving here
 * already use, and Claude's is the one connection that is a single click.
 * Coding agents follow: the local server still serves everything the hosted
 * endpoint does PLUS the plugins' local-only tools, but it asks for Node and a
 * config file, which is the wrong first thing to put in front of everyone. A
 * coding agent can edit its own settings, so it gets a prompt to paste.
 *
 * This file is the PICKER's data and nothing else: which clients to offer,
 * what to call them, and how to say where the snippet goes. `AgentClientPicker`
 * renders it on the welcome page and on the External agent access page, so
 * the two offer the same clients, in the same words, at the same address, by
 * construction. They used to agree by convention only: the settings page
 * hand-built the same address in six places and wrote its own instructions.
 */

/** A closed row under a client's snippet: another way in, or what to do when it fails. */
export interface AgentClientMore {
  summary: string;
  /** One or two plain sentences. */
  text?: string;
  /** Something to copy. */
  value?: string;
}

export interface AgentClient {
  id: 'claude' | 'chatgpt' | 'other' | 'local';
  label: string;
  /**
   * Where the snippet goes, in one short line, said as the path through that
   * client's own UI. A list renders as numbered steps, for a path with enough
   * turns that one sentence of arrows loses people halfway. No more than this:
   * whatever only some readers need is a closed row in `more`.
   */
  hint: string | string[];
  /** What the copy button carries for this client. */
  snip(mcpUrl: string): string;
  /**
   * A prompt the reader pastes into the agent, so the agent connects itself.
   * Where a client has one, "Copy prompt" is the one action and the snippet
   * moves into "Or add it by hand": an agent that can edit its own settings
   * should not need its owner to.
   */
  prompt?(mcpUrl: string): string;
  /**
   * Closed rows after the snippet. One thing is in front of the reader at a
   * time: the snippet for the client they picked. Other ways in and
   * troubleshooting wait until asked for.
   */
  more?(mcpUrl: string): AgentClientMore[];
}

export const AGENT_CLIENTS: AgentClient[] = [
  {
    id: 'claude',
    label: 'Claude',
    // Shown on its own where there is no one-click link, and inside "Or add
    // it by hand" where there is one.
    hint: 'In Claude, open Settings → Connectors → Add custom connector and paste this address.',
    snip: (url) => url,
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    // ChatGPT renamed the page under our feet: as of 2026-09 it is Plugins,
    // where it used to be Apps & Connectors with Developer mode under
    // Advanced. The first step names both, so whichever build someone is on,
    // the words on their screen are in the steps. Developer Mode comes before
    // Create because it is off by default and hides that button. The name is
    // spelled out because, unlike Claude, ChatGPT has no link that prefills it.
    hint: 'In ChatGPT, open Settings → Plugins, turn on Developer Mode, choose Create and paste this address.',
    snip: (url) => url,
    more: () => [
      {
        summary: 'Step by step',
        text: `Plugins is called Apps & Connectors in older versions, where Developer Mode sits under Advanced. Choose Create (or Add), name it “${MCP_DISPLAY_NAME}”, paste the address and save.`,
      },
    ],
  },
  {
    id: 'local',
    // Named for what people call them. Claude Desktop is the Claude option.
    label: 'Coding agents',
    hint: 'Paste this into the agent’s MCP settings. Needs Node 22.13+ or 24.',
    prompt: () =>
      [
        `Connect yourself to my company's knowledge base, "${MCP_DISPLAY_NAME}". It is an MCP server.`,
        '',
        'First check that `node --version` prints 22.13 or newer. If it does not, stop and tell me.',
        '',
        'If you are Claude Code, run this command. It adds the server for all my projects:',
        '',
        hexisMcpClaudeCommand(workspaceBaseUrl()).replace('claude mcp add ', 'claude mcp add --scope user '),
        '',
        'If you are another agent, merge this into your own MCP settings file (Cursor: ~/.cursor/mcp.json, Windsurf: ~/.codeium/windsurf/mcp_config.json, Cline: its MCP settings), keeping what is already there:',
        '',
        hexisMcpJsonSnippet(workspaceBaseUrl()),
        '',
        'The first time the server starts, a browser window opens so I can sign in. Tell me if I have to restart you, then list the tools you got from it.',
      ].join('\n'),
    // The passed endpoint is deliberately unused: the local server takes the
    // WORKSPACE address and asks it for the MCP endpoint itself
    // (`GET /api/config`), so the URL every other client pastes is the wrong
    // value here: see `workspaceBaseUrl`.
    snip: () => hexisMcpJsonSnippet(workspaceBaseUrl()),
    more: () => [
      // A POSIX one-liner, so the row says where it runs: on Windows the JSON
      // above is the route.
      {
        summary: 'Claude Code on macOS, Linux or WSL: one command',
        value: hexisMcpClaudeCommand(workspaceBaseUrl()),
      },
      // The PATH trouble is the one failure most people on a Mac meet: an
      // agent started from the Dock does not see the shell's PATH, and the fix
      // for `npx` hits the same gap again for `node`.
      {
        summary: 'If the agent says npx was not found',
        text: 'It was started from the Dock or a desktop icon and cannot see your shell’s PATH. To fix it, run `which npx` in a terminal (`where.exe npx` in PowerShell) and put the full path it prints in place of "npx" above. On Windows, double each backslash. If it then reports `env: node: No such file or directory`, add that same folder to the configuration’s "env" PATH, in front of the system folders.',
      },
    ],
  },
  {
    id: 'other',
    label: 'Other',
    // The bare address first: plenty of tools take a URL and nothing else, and
    // the reader is a business user for whom "a JSON config" says nothing.
    hint: 'In your tool’s settings, add an MCP server (also called a connector) and paste this address.',
    snip: (url) => url,
    more: (url) => [
      { summary: 'As a JSON configuration', value: jsonConfigSnippet(url) },
      { summary: 'Claude Code: one command, nothing to install', value: claudeCodeCommand(url) },
    ],
  },
];
