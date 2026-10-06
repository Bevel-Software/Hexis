---
'@bevel-software/hexis-mcp': minor
'@bevel-software/platform-core-frontend': patch
---

The local MCP server signs in as the agent that runs it, never as itself.

Until now a client that did not name itself in the MCP handshake was signed in as "hexis-mcp on <machine>", and the Audit log showed the local server as the acting agent. Now:

- A nameless client is identified from the process tree: the server walks past `npx`, `node` and the shells to the program that spawned them (Claude, Cursor, VS Code, …) and signs in as that program. The sign-in line on stderr says whether the name came from the handshake or was guessed.
- When nothing can be read it signs in as "Unknown agent · local server on <machine>", so the Audit log never attributes a call to the server itself.
- Server logs never reach stdout. A dependency that logged with `console.log` on every connection wrote into the JSON-RPC channel, and the reply to `tools/list` was lost with it: the client reported "Failed to fetch tools: Request timed out" and no tools loaded. Every console method that writes to stdout is pointed at stderr before any other module loads.
- The connect snippets spawn `@bevel-software/hexis-mcp@latest`, so `npx` refreshes the cached copy instead of reusing a stale one forever.
