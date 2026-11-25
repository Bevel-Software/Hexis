---
"@bevel-software/platform-core-backend": patch
"@bevel-software/hexis-mcp": patch
---

A connection key never receives a secret value. The local-tools variables route now answers only the local MCP server signed in through the person's browser, and refuses a connection key, an agent's internal token, a hosted loopback token and a browser session before it looks the tool up. A shared (`admin`-scope) value is released only to a writer of the `.tool` and reported as `withheld` to anyone else. `hexis-mcp` run with `--key` no longer asks: its local tools take their variables from the MCP client config's environment.
