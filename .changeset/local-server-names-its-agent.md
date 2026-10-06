---
'@bevel-software/hexis-mcp': minor
'@bevel-software/platform-core-frontend': patch
---

The local MCP server signs in as the agent that runs it, never as itself.

Until now a client that did not name itself in the MCP handshake was signed in as "hexis-mcp on <machine>", and the Audit log showed the local server as the acting agent. Now:

- A nameless client is identified from the process tree: the server walks up from its parent to the nearest ancestor that is an agent it knows (Claude, Cursor, VS Code, Windsurf, Zed, Codex, Gemini CLI, Cline — by executable, macOS bundle, or, for one running on `node`, by the package its command line names) and signs in as that agent. The sign-in line on stderr says whether the name came from the handshake or was guessed.
- When no known agent is found it signs in as "Unknown agent · local server on <machine>": a terminal, a daemon or an unknown program is never put on the Audit log as the agent, and neither is the server itself.
- Server logs never reach stdout. A dependency that logged with `console.log` on every connection wrote into the JSON-RPC channel, and the reply to `tools/list` was lost with it: the client reported "Failed to fetch tools: Request timed out" and no tools loaded. The global console is replaced, before any other module loads, by one bound to stderr on both streams, so `log`, `dir`, `table`, `count` and the rest all land there.
- The connect snippets spawn `@bevel-software/hexis-mcp@latest`, so `npx` refreshes the cached copy instead of reusing a stale one forever.
