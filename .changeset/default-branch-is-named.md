---
'@bevel-software/platform-core-backend': minor
---

A connected agent is told which branch is the default. The agent instructions — the MCP handshake `instructions`, `GET /api/agent/instructions` and the managed guide's "Working with files" section, which carry the same text — name the deployment's default branch in one sentence under "This knowledge base's own conventions": the branch people read, the one a tool with an optional `branch` runs on, and the usual target of a change request. `start_session` answers `{ sessionId, defaultBranch }` (plus `firstRun` while the knowledge base is empty, as before), and its description and output schema say so. Both read the setting in effect, so a renamed default branch is named after the restart that applies it. Until now nothing an agent received named the branch, and an agent left to guess wrote to `main` on deployments whose default is another branch.

For callers of the composers: `sharedFileRules`, `sharedFileRulesSection`, `platformInstructions` and `renderTemplateText` take the default branch as a new required argument; `composeAgentInstructions`, `coreAgentGuideSections`, `createAgentInstructionsRoutes`, `McpService`'s options and `AgentGuideContext` take it optionally, and name no branch without it.
