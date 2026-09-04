## Why

An agent connected to Hexis over MCP is told how each tool works ("Read a workspace file as text", "Regex content search across the workspace") and nothing about what the knowledge base contains or when to look in it. Whether the model searches the KB before answering from memory is left to its own judgement, and a question about a customer's permitting process gets answered from memory. Other connectors (Notion, Sitefire) send server instructions on the MCP handshake; Hexis sends none. Customers have asked for a preamble they can write themselves, per knowledge base, because only they know what is in their repository.

## What Changes

- Every MCP session Hexis serves, hosted and through the local `hexis-mcp` bridge, carries `instructions` on the initialize handshake. MCP clients inject that text into the model's system prompt without the model having to do anything.
- The instructions are composed server-side from two layers: a short fixed platform header owned by the code (what Hexis is, search the knowledge base before answering from memory, call `start_session` first), followed by a deployment preamble the admin writes.
- The deployment preamble lives in the knowledge-base repository as `mcp-description.md` at the repo root, on the default branch. It is seeded from the template when missing and never rewritten by the platform. It is versioned, reviewable through change requests, and moves with the repository.
- A new agent-facing endpoint returns the composed text so both the hosted proxy and the local bridge read one source of truth.
- The External agent access page shows what connected agents are told, with the character count against the cap and an Edit link for admins.
- The managed `AGENTS.md` points agents that clone the repository directly at `mcp-description.md`.

Nothing is removed. Deployments that never touch `mcp-description.md` still get the platform header, which alone gives the model the "search here first" signal it lacks today.

## Capabilities

### New Capabilities
- `agent-instructions`: what a connected agent is told at the start of an MCP session: how the text is composed, capped and delivered on the hosted endpoint and through the local bridge, with which privileges it is read, and what happens when it cannot be read.
- `agent-preamble`: the admin-written part of those instructions: where the file lives, how it is seeded, who may change it, and how the app shows and links to it.

### Modified Capabilities

None. There are no existing specs under `openspec/specs/`; this change introduces OpenSpec to the repository.

## Impact

- **core-backend**: a new `agent-instructions` module (composer, route); `McpService.createSession` fetches the text over loopback and passes `instructions` to the SDK `Server`; the KB template gains `mcp-description.md` and the managed `AGENTS.md` gains a pointer; `REQUIRED_FILES` in the startup phase grows by one.
- **hexis-mcp**: fetches the same endpoint at startup and passes `instructions` to its own `Server`. Older deployments without the endpoint still work; the bridge then sends no instructions.
- **core-frontend**: a card on the External agent access page and one API function.
- **Every deployment**: the platform header is sent to every session from the first boot after the upgrade. The text lands in every conversation's system prompt on every connected client, so its size is capped.
- **Dependencies**: none added. `@modelcontextprotocol/sdk` 1.30 already supports `instructions` on `Server` and `Client.getInstructions()`.
