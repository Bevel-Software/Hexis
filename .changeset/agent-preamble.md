---
'@bevel-software/hexis-mcp': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

Every MCP session now tells the model what Hexis is and to search the knowledge base before answering from memory. The text is a fixed platform header plus `mcp-description.md`, a new admin-edited file at the repository root, seeded from the template on the first boot after upgrading and never rewritten. It arrives as `instructions` on the initialize handshake, from the hosted endpoint and from `hexis-mcp` alike, and its first line is also prepended to the `start_session`, `grep`, `list_files` and `read_file` descriptions for clients that drop the handshake field. `GET /api/config` advertises `agentInstructions: true`; `GET /api/agent/instructions` serves the composed text; the External agent access page shows both channels with their character counts and, for admins, an Edit link.
