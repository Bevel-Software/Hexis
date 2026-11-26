---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-frontend': minor
---

The agent instructions (the MCP handshake `instructions` and `GET /api/agent/instructions`) now fit the length Claude Code keeps, so the deployment's description reaches a Claude Code agent. Claude Code cuts a server's instructions at 4,096 characters (2,048 in older versions), and the rules every file tool shares used to sit between the platform header and the description, so the description was cut off.

- The instructions are now the guide-first line, the platform header, one sentence pointing at the guide's `working-with-files` section, the default-branch sentence, and then the description. The shared file rules are stated only in the guide.
- `INSTRUCTIONS_CAP` is 4,096, the limit measured on Claude Code 2.1.332. With a typical branch name, the opening and the start of the description fall within the first 2,000 characters.
- `PREAMBLE_CAP` drops from 6,000 to 1,800, so the whole text fits that limit. The External agent access card and the `mcp-description.md` template now show the new cap.
- `composeAgentInstructions(preamble, defaultBranch)` and `platformInstructions(defaultBranch)` no longer take a layout, because nothing they write depends on it now. For the same reason, `createAgentInstructionsRoutes` and the MCP service's options drop their `kbLayout` getter.
