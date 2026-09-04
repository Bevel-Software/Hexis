# TODOS

## Agent instructions

### Automated eval harness for the header and tool prefix

**What:** A vitest file under core-backend, skipped unless an API key env var is set, that sends the composed instructions plus the tool list to the Claude API and asserts the first tool call for three fixed organisation-specific questions.

**Why:** The header is a prompt; prompts drift; nothing in CI notices. The manual eval in the agent-preamble change proves today's wording once; every later edit ships blind.

**Context:** The composer lives in `packages/core-backend/src/modules/agent-instructions/compose.ts`. The three baseline questions and their before/after results are recorded in the agent-preamble PR description; encode those as the fixtures. Decide how an API key reaches CI before writing the test.

**Effort:** M
**Priority:** P3
**Depends on:** The agent-preamble change landing.

### Echo the instructions from `start_session` as a third channel

**What:** Include `instructions` in the `start_session` result for external sessions, so a client that drops the handshake and truncates tool descriptions still receives the full preamble on its first call.

**Why:** After agent-preamble the model gets the full text through the handshake and a 300-character prefix on four tools. A client that ignores the handshake sees only the prefix.

**Context:** `start_session` is external-only at `packages/core-backend/src/modules/workspace/workspace.tools.ts:373`; the composer's result is available in-process in `McpService`. The earlier decision rejected this as the only channel because it arrives after the model decides to call; as a complement it is one field on an existing result. Build it only if the manual eval in the agent-preamble PR shows a client that needs it.

**Effort:** S
**Priority:** P3
**Depends on:** The agent-preamble change and its recorded eval results.

### Per-plugin instructions scoped by access

**What:** A per-plugin file (for example `Plugins/<Plugin>/agent-instructions.md`) appended to the composed text for callers who can read that plugin, under its own cap.

**Why:** Team-specific guidance today has no channel except the global preamble, which every agent sees.

**Context:** Turns the privileged broadcast into per-caller composition: the hosted proxy needs the caller's access resolution (`accessControl.canReadBatch`, see `tool-manuals.routes.ts:145`), and the composer needs a second layer with its own cap. Keep `composeAgentInstructions` pure so a wrapper can add the layer.

**Effort:** L
**Priority:** P3
**Depends on:** The agent-preamble change.

### Generated index of readable folders and ontologies

**What:** A composer extension point that appends a per-caller list of readable top-level folders (and, through the enterprise `CorePorts` seam, ontologies) under the admin text, within its own cap.

**Why:** Hand-written tables of contents go stale; the platform knows the tree and who may read it.

**Context:** The design of agent-preamble names this as the seam the enterprise overlay wants for graph-aware summaries. It is per-caller, so it builds on the per-plugin item above.

**Effort:** L
**Priority:** P4
**Depends on:** Per-plugin instructions scoped by access.

### Inline editing form for the preamble

**What:** A textarea on the "What connected agents are told" card that commits `mcp-description.md` as the admin, with live counts for both channels.

**Why:** Tuning a 300-character purpose sentence against a live counter is a better loop than editor, save, return, read.

**Context:** Precedent is the `roles.yaml` admin page. The Knowledge editor's commit path is the reference implementation; a second write path needs its own lock and conflict story. Build only on usage signal that admins tune the prefix often.

**Effort:** M
**Priority:** P4
**Depends on:** The agent-preamble change.

## hexis-mcp

### Verify the local-token "too old" check answers 404, not 401

**What:** Confirm what an older deployment answers for `POST /api/mcp/local-token` and align the message in `packages/hexis-mcp/src/oauth.ts:522-535`.

**Why:** The engineering review of agent-preamble verified that an unknown `/api/agent/*` path on an older deployment falls past the agent router into the JWT-protected mounts and answers 401, never 404. The local-token check assumes 404 to show its helpful "this deployment is too old for browser sign-in" message; if the same fall-through applies under `/api/mcp`, users see the generic "rejected the sign-in" error instead.

**Context:** MCP routes mount before the JWT mounts (`create-core-server.ts:267` and `:387`); an unknown sub-path under `/api/mcp` may still fall through. Reproduce with a config stub or an older deployment, then either keep the 404 branch or add the 401 case with the same message.

**Effort:** S
**Priority:** P2
**Depends on:** None
