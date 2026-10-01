---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
---

Hexis offers neutral session hooks and no longer knows what an ontology is.

Before every agent read and every agent write of a knowledge-base path, the server now calls a hook a deployment registered — on exactly the calls that were gated before, including each extracted entry of `unzip`, both ends of `move_file` and `copy_file`, and the session-level check of `execute_command`. Each hook is handed the session id the call carried (or nothing, when it carried none), the path when the operation has one (`execute_command` has none, so its check is at session scope), the branch, the calling user and whether the caller is the in-app agent or an external one. A hook that throws refuses the operation, and the caller reads that hook's own message and status; for `write_files` and `unzip` the refusal is reported for that path alone and the other paths still land. Calls that are not from an agent, and calls by the recovery bot, never reach the hooks.

Hexis registers no hook, so nothing is refused and nothing is recorded, and a file tool call without a `sessionId` succeeds. `start_session` still returns a session id and the file tools still accept `sessionId`; the descriptions now say what the id is — this conversation's id, the same one `ask` takes — and no text an agent or a person can read from a Hexis-only deployment contains the word "ontology". A deployment that has a boundary of its own registers the wording for it through `ToolDescriptionNotes`, and it is appended to the gated tools' descriptions and to the `sessionId` input.

The table `session_ontology_touches` stays in the database in this release and nothing reads or writes it; the following release drops it (`TODOS.md`).

For integrators, this removes the whole ontology half of the boundary. Gone from `@bevel-software/platform-core-backend`:

- `modules/workspace/session-ontology.gate.js`, the whole module — `recordOntologyRead`, `assertOntologyWriteAllowed`, `assertShellAllowedWithinOntology`, `SessionOntologyGate`, `OntologyWriteBlockedError`, `MissingSessionError`, `ONTOLOGY_BOUNDARY_NOTE` and the module's `SESSION_ID_INPUT`.
- `modules/workflow/session-ontology.service.js`, the whole module — `SessionOntologyService`, `ISessionOntologyService`, `OperationDecision`.
- `modules/workflow/session-ontology.policy.js`, the whole module — `recordTouch`, `decideWrite`, `WriteDecision`.
- `shared/kb-layout.js`, the whole module — `ontologyOf`.
- `PreWriteContext`, from `modules/workflow/workflow-hooks.js` and from the package root.
- `sessionOntologyService`, from `CoreServices`.
- `ontologySessionBlock`, from `CoreConfig` and from the tenant settings `StaticTenantSource` reads. The variable `ONTOLOGY_SESSION_BLOCK` is ignored: setting it has no effect and causes no error, and it is out of `docs/configuration.md`.

Gone from `@bevel-software/platform-shared`:

- `ontologyRoots`. `ONTOLOGY_MARKERS`, `KNOWLEDGE_DIR`, `NODETYPE_DIR`, `DATA_DIR` and the `Ontology` type stay, as the vocabulary a graph parser builds on.

New, in `modules/workspace/agent-access.gate.js`:

- `notifyAgentRead(gate, ctx, branch, wsPath)` and `assertAgentWriteAllowed(gate, ctx, branch, wsPath?)`, and the `AgentAccessGate` they take — `{ recoveryBotEmail, hooks, notes }`, with no service, no `enabled` flag and no `kb`.
- `ToolDescriptionNotes`, the registration point for the wording: `registerGatedToolNote(note)` and `registerSessionIdNote(note)`, plus `onChange(listener)` so a note registered after the tools were mounted still reaches them. Hexis registers neither.
- `SESSION_ID_INPUT` and `SESSION_ID_DESCRIPTION`, the unadorned default the notes are applied on top of.

Changed:

- `WorkflowHooks` gains `onAgentRead(hook)` and `runAgentRead(ctx)`. `onPreWrite` and `runPreWrite` keep their names, and both hooks now take `AgentOperationContext` (`{ sessionId?, wsPath?, branch, user, source }`) in place of `PreWriteContext` — so a handler registered against `onPreWrite` reads `ctx.wsPath` where it used to switch on `ctx.kind`, and a shell call is the one with no `wsPath`. `AgentOperationContext` and `AgentReadHook` are exported from the package root.
- `ToolSurfaceCtx.sessionOntologyGate` is now `agentAccessGate`, of the new type, and `registerWorkspaceTools` takes that gate as its ninth argument.
