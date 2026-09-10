## 1. Composer, reader and endpoint (core-backend)

- [x] 1.1 Create `modules/agent-instructions/compose.ts`: export the platform header constant (final text in design.md decision 2), the fixed prefix line, and `composeAgentInstructions(preamble: string | null)` returning `{ instructions, header, preamble, toolPrefix, toolPrefixLine, truncated, preambleChars, toolPrefixTruncated, toolPrefixChars, unterminatedComment }` (the parts support the card while both channel counts remain in the API): strip well-formed HTML comments; strip from an unterminated `<!--` to end of file and set the flag; trim; cap the preamble at 6,000 characters with the marker; build the prefix as fixed line + first non-heading paragraph capped at 300; both cuts on a code-point boundary; counts reported before truncation
- [x] 1.2 Add `readAgentPreamble` beside it: `await workspaceService.getOrCreateForBranch(DEFAULT_BRANCH)`, then read `<workspace>/<kbDirName>/mcp-description.md` symlink-safe (lstat, then an `O_NOFOLLOW` open read through the checked handle, the plugin archive's rule); ENOENT returns `null`; a symlink or any non-regular entry throws, as does any other error
- [x] 1.3 Mount `GET /agent/instructions` under `manualAuth` on the same tools router as `all-tools`; answer the composer's result with `Cache-Control: no-store`; a reader throw is a 500. (Landed as `modules/agent-instructions/agent-instructions.routes.ts`, mounted in `create-core-server.ts` right after the tool-manuals agent routes, taking the shared reader rather than `{ workspaceService, kbDirName }`: one reader, two consumers.)
- [x] 1.4 Add `agentInstructions: true` to `GET /api/config`. (The payload moved to the pure `core/public-config.ts` so it can be tested without a server.)
- [x] 1.5 Unit tests for the composer (`__tests__/compose.test.ts`): header only for null, empty, whitespace and comment-only; comments stripped from both outputs; unterminated comment strips to EOF and sets the flag; cap and marker; exactly 6,000 sends whole; count reported before truncation; CRLF input still yields the first paragraph; prefix skips headings; prefix fallback when the preamble is empty or heading-only; prefix at most 300 and starts with the fixed line; a cut that would split a surrogate pair moves before it
- [x] 1.6 Route test (`modules/agent-instructions/__tests__/agent-instructions.route.test.ts`): 200 with a connection key, an internal token and a browser JWT; 401 without a credential; `Cache-Control: no-store` present; ENOENT yields the header alone; a non-ENOENT read error yields 500
- [x] 1.7 Test that `/api/config` carries `agentInstructions: true` (`core/__tests__/public-config.test.ts`)

## 2. Hosted proxy (core-backend)

- [x] 2.1 Give `McpService` an `AgentPreambleReader` at construction (`McpProxyOptions.readAgentPreamble`, wired in `create-core-services.ts` beside the session store); in `createSession` call it, compose, and pass `instructions` to `new Server(...)`
- [x] 2.2 On a reader throw, fall back to the header alone and the fixed prefix line with a logged warning; the session still initialises
- [x] 2.3 In the `tools/list` handler, prepend `toolPrefix`, a blank line, then the original description to exactly `start_session`, `grep`, `list_files` and `read_file`; every other tool untouched, meta-tools untouched; applied after the connection-key credential filter
- [x] 2.4 e2e (`mcp.e2e.test.ts`): `client.getInstructions()` carries the header and the preamble body; a second session after the stubbed reader returns new content carries the new text
- [x] 2.5 Unit (`mcp.service.test.ts`): a throwing reader still yields a session whose instructions are the header; the four KB tools carry the prefix; every other tool's description is byte-for-byte unchanged (regression); a connection-key session with filtered tools still prefixes the four

## 3. Template and startup phase (core-backend)

- [x] 3.1 Add `kb-template/mcp-description.md` as ONE HTML comment: first line says removing the wrapper broadcasts the text; then the explanation that every connected agent reads it at session start whatever its access, that the content should stay under 6,000 characters and the first paragraph under about 220 (the fixed purpose sentence and it together are cut at 300); then the starter skeleton (what this KB holds, what is where, always check here before answering about, conventions)
- [x] 3.2 Add `mcp-description.md` to `REQUIRED_FILES` in `template-files.step.ts`; confirm it is not in the managed-refresh path and list root-anchored `/mcp-description.md` in the template `.bevelignore`. (Also in `PACKAGED_FALLBACK_FILES`: a custom `KB_TEMPLATE_DIR` that predates the file gets the packaged copy with one log line instead of a failed boot.)
- [x] 3.3 Add the pointer to the managed `AGENTS.md`: read `mcp-description.md` first for what the knowledge base contains and when to consult it; MCP sends the default branch's copy, a clone reads its own branch's
- [x] 3.4 Regression (CRITICAL): add `mcp-description.md` to `fullScaffold()` and to the hard-coded list in `steps.test.ts` (lines 119 and 135), or the CRLF no-churn test at line 204 fails with a scaffolding commit
- [x] 3.5 Extend `steps.test.ts`: seeded when missing on every protected branch; untouched when present; an emptied file stays empty; the shipped template composes to the header alone; the template `AGENTS.md` names `mcp-description.md`
- [x] 3.6 Reconcile the root `.bevelignore` on existing protected branches so `mcp-description.md` is hidden by default, preserve an explicit `!mcp-description.md`, and cover the resulting workspace-tree filter
- [x] 3.7 Respell the platform's OWN unanchored `mcp-description.md` rule as `/mcp-description.md` in `template-files.step.ts` (`withPlatformIgnorePatternRespelled`, provenance by the platform comment, applied to the declared template content and through `reconcileIgnoreRules`); keep an unanchored rule the operator wrote; tests in `steps.test.ts`

## 4. Local bridge (hexis-mcp)

- [x] 4.1 In `deployment.ts` add `resolveDeployment(config): Promise<{ mcpUrl, agentInstructions: boolean }>` from the one `/api/config` fetch; `resolveMcpUrl` becomes a wrapper returning `.mcpUrl` (public export, string consumers in `cli.ts` and `server.ts` unchanged)
- [x] 4.2 Add `fetchAgentInstructions(config): Promise<string | undefined>` using `getJson`; a body without an `instructions` string, a non-2xx status or a network error logs one line and resolves to `undefined`
- [x] 4.3 In `createHexisMcpServer` call `resolveDeployment`; when `agentInstructions` is true fetch before constructing the `Server` and pass `instructions`; when false log one line naming the older deployment
- [x] 4.4 `catalog.test.ts`: `resolveDeployment` reports the flag present and absent beside the existing older-deployment case; `fetchAgentInstructions` on 200, malformed body, 500 and network error
- [x] 4.5 The initialize result carries the text when the fake deployment advertises the flag and serves the endpoint; carries none when the config has no flag; carries none when the flag is set but the endpoint answers 500. (Landed as `server.instructions.test.ts`, on the faked-deployment harness the swap and teardown tests use: `stdio.e2e.test.ts` never drives `createHexisMcpServer`.)

## 5. Frontend card (core-frontend)

- [x] 5.1 Add `fetchAgentInstructions()` to a new `services/agent-instructions.api.ts`, calling `/api/agent/instructions` through `authFetch`
- [x] 5.2 Put the Your agent / Marketplaces / Autonomous agents connection card first, then render "What agents are told about this knowledge base" as a separate peer card: fixed platform message in a closed drawer and the admin description with `N / 6,000 characters`; omit the short-prefix preview and repository implementation copy
- [x] 5.3 Admins (`useContext(AdminContext)?.isAdmin ?? false`) get an inline Edit action once `kbDirName` is known; load `${kbDirName}/mcp-description.md` from the default-branch workspace and save through the normal workspace write route; non-admins remain read-only
- [x] 5.4 Regression: mock the new API module in the hoisted `vi.mock` set of `ExternalAgentAccessPage.test.tsx` and keep the card tolerant of absent providers so the 20 existing cases still pass
- [x] 5.5 Component tests: platform drawer and description count render; inline Edit only for admins and only once `kbDirName` is known; edit/save and save-error paths; preamble truncation and comment warnings; preview-fetch failure still permits editing; both tabs keep working
- [x] 5.6 Source helpers strip private comments from the textbox, preserve them on save, close an unterminated private comment, and treat a missing backing file as an empty description
- [x] 5.7 Filter the exact root `mcp-description.md` from merged workspace trees as defense in depth, without filtering nested files with the same basename; memoized in `useMergedWorkspaceTree.ts` on the tree and `kbDirName`, like every step beside it
- [x] 5.8 `AgentInstructionsCard.tsx`: offer the Edit action on a non-empty `kbDirName` so it matches `beginEdit`'s guard, and ticket the composed-preview requests so only the newest lands (an initial load resolving after a post-save refresh must not restore the pre-save text)
- [x] 5.9 `agent-instructions.api.ts` sends the loaded bytes as `ifMatch` on the save, so a file changed since the editor opened is refused instead of overwritten; `workspace.api.ts` `writeFile` grows the option; tests in `__tests__/agent-instructions.api.test.ts` and `__tests__/AgentInstructionsCard.test.tsx`
- [x] 5.10 `AgentInstructionsCard.tsx` checks a mounted ref beside the ticket, re-armed on effect entry: a save in flight at unmount starts its own refresh afterwards, which takes a fresh ticket, and StrictMode's teardown-then-setup runs on the same card (covered by a StrictMode mount test)

## 6. Docs and release

- [x] 6.1 README FAQ entry: "How does an agent know what is in the knowledge base?"
- [x] 6.2 Rewrite the parenthetical in `packages/mcp-core/src/meta-tools.ts` (line 10-11): the header now arrives as initialize instructions; the code-mode protocol stays in the description because several clients drop that field; point at `modules/agent-instructions/compose.ts`
- [x] 6.3 Changeset for the fixed version group per `.changeset/README.md`
- [x] 6.4 Fill `openspec/config.yaml` context so later changes start from the repository's conventions
- [x] 6.5 `TODOS.md` created by the engineering review with the deferred follow-ups

## 7. Workspace file routes (core-backend)

- [x] 7.1 `workspace.service.ts` `writeFile` takes `expectedContent`: read-compare-and-write in one step so the route's per-path lock covers it, a mismatch throwing a 409 that `sendError` maps; an absent file compares as the empty string
- [x] 7.2 `workspace.routes.ts` `PUT /workspace/:id/file` accepts `ifMatch` (a string or nothing, 400 otherwise) and passes it as `expectedContent`
- [x] 7.3 `workspace.routes.ts` `GET /workspace/:id/file` answers 404 for ENOENT, ENOTDIR and EISDIR only, and sends every other read failure through `sendError` (traversal 403, a malformed workspace id its domain status, an unreadable file 500), so a caller cannot read a read failure as a missing file
- [x] 7.4 Tests: service-level conditional write in `__tests__/workspace.service.test.ts`; route-level `ifMatch` pass-through and read-error mapping in `__tests__/workspace.routes.file-writes.test.ts`
- [x] 7.5 `workspace.service.ts` serializes mutations per file (`writeTurns`, `withPathTurn`), so the conditional compare and its write are exclusive even when `PUT /file` runs the op without acquiring the lock (a caller that already holds it). Keyed by the RESOLVED path, so `x/a.md`, `./x/a.md` and `x//a.md` are one queue; re-entrant through an `AsyncLocalStorage` of held turns, so a caller that wraps a sequence can still call `writeFile` inside it; `deleteFile` and `writeFileBinary` take the same turn (`moveEntry` deliberately does not: two paths, and holding both is the one shape that could deadlock). Covered by two concurrent conditional saves where exactly one lands, the spelling and per-file cases, re-entrancy, a throwing turn not wedging the queue, and a delete plus an upload held until a turn ends
- [x] 7.6 `workspace.service.ts` exports `assertContentMatches` and `PUT /file` runs the precondition, `planForCreate`, the seed and the write inside ONE `withPathTurn` for the target, so a stale save is refused before a seeded `access.md` commits and nothing can land between the check and the write; a directory at the path is a 400 naming it, not a raw 500, matching the GET route's EISDIR reading. Route test asserts the order `turn:enter, precondition, plan, seed, write, turn:exit`, and `turn:enter, precondition, turn:exit` on a refusal

## 8. Verification

- [x] 8.1 `pnpm typecheck`, `pnpm lint`, `pnpm test` green
- [ ] 8.2 Manual: connect Claude Code to a local deployment with `claude mcp add`, confirm the instructions appear in its MCP server instructions block, edit `mcp-description.md`, open a new session, confirm the edit is there
- [ ] 8.3 Manual: connect through `hexis-mcp` and confirm the same text arrives; point `hexis-mcp` at a config stub without the flag and confirm it starts with the one log line
- [ ] 8.4 Manual eval, recorded in the PR description: one fixed organisation-specific question asked in Claude Code, claude.ai web and Cline, with and without the preamble; note whether the first tool call is `start_session` or `grep`, and whether claude.ai shows the fixed line at the start of the four tool descriptions
