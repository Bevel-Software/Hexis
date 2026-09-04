## 1. Composer, reader and endpoint (core-backend)

- [ ] 1.1 Create `modules/agent-instructions/compose.ts`: export the platform header constant (final text in design.md decision 2), the fixed prefix line, and `composeAgentInstructions(preamble: string | null)` returning `{ instructions, toolPrefix, truncated, preambleChars, unterminatedComment }`: strip well-formed HTML comments; strip from an unterminated `<!--` to end of file and set the flag; trim; cap the preamble at 6,000 characters with the marker; build the prefix as fixed line + first non-heading paragraph capped at 300; both cuts on a code-point boundary; counts reported before truncation
- [ ] 1.2 Add `readAgentPreamble` beside it: `await workspaceService.getOrCreateForBranch(DEFAULT_BRANCH)`, then `workspaceService.readFile(workspaceIdForBranch(DEFAULT_BRANCH), `${kbDirName}/mcp-description.md`)`; ENOENT returns `null`; any other error throws
- [ ] 1.3 Mount `GET /agent/instructions` under `manualAuth` next to `all-tools` in `tool-manuals.routes.ts`, taking `{ workspaceService, kbDirName }` like `archiveDeps`; answer the composer's result with `Cache-Control: no-store`; a reader throw is a 500
- [ ] 1.4 Add `agentInstructions: true` to `GET /api/config` in `create-core-server.ts`
- [ ] 1.5 Unit tests for the composer (`__tests__/compose.test.ts`): header only for null, empty, whitespace and comment-only; comments stripped from both outputs; unterminated comment strips to EOF and sets the flag; cap and marker; exactly 6,000 sends whole; count reported before truncation; CRLF input still yields the first paragraph; prefix skips headings; prefix fallback when the preamble is empty or heading-only; prefix at most 300 and starts with the fixed line; a cut that would split a surrogate pair moves before it
- [ ] 1.6 Route test (`__tests__/tool-manuals.instructions.route.test.ts`): 200 with a connection key, an internal token and a browser JWT; 401 without a credential; `Cache-Control: no-store` present; ENOENT yields the header alone; a non-ENOENT read error yields 500
- [ ] 1.7 Test that `/api/config` carries `agentInstructions: true`

## 2. Hosted proxy (core-backend)

- [ ] 2.1 Give `McpService` an `AgentInstructionsReader` at construction (wired in `create-core-services.ts` beside `SkillService`); in `createSession` call it, compose, and pass `instructions` to `new Server(...)`
- [ ] 2.2 On a reader throw, fall back to the header alone and the fixed prefix line with a logged warning; the session still initialises
- [ ] 2.3 In the `tools/list` handler, prepend `toolPrefix`, a blank line, then the original description to exactly `start_session`, `grep`, `list_files` and `read_file`; every other tool untouched, meta-tools untouched; applied after the connection-key credential filter
- [ ] 2.4 e2e (`mcp.e2e.test.ts`): `client.getInstructions()` carries the header and the preamble body; a second session after the stubbed reader returns new content carries the new text
- [ ] 2.5 Unit (`mcp.service.test.ts`): a throwing reader still yields a session whose instructions are the header; the four KB tools carry the prefix; every other tool's description is byte-for-byte unchanged (regression); a connection-key session with filtered tools still prefixes the four

## 3. Template and startup phase (core-backend)

- [ ] 3.1 Add `kb-template/mcp-description.md` as ONE HTML comment: first line says removing the wrapper broadcasts the text; then the explanation that every connected agent reads it at session start whatever its access, that the content should stay under 6,000 characters and the first paragraph under 300; then the starter skeleton (what this KB holds, what is where, always check here before answering about, conventions)
- [ ] 3.2 Add `mcp-description.md` to `REQUIRED_FILES` in `template-files.step.ts`; confirm it is not in the managed-refresh path and not listed in the template `.bevelignore`
- [ ] 3.3 Add the pointer to the managed `AGENTS.md`: read `mcp-description.md` first for what the knowledge base contains and when to consult it; MCP sends the default branch's copy, a clone reads its own branch's
- [ ] 3.4 Regression (CRITICAL): add `mcp-description.md` to `fullScaffold()` and to the hard-coded list in `steps.test.ts` (lines 119 and 135), or the CRLF no-churn test at line 204 fails with a scaffolding commit
- [ ] 3.5 Extend `steps.test.ts`: seeded when missing on every protected branch; untouched when present; an emptied file stays empty; the shipped template composes to the header alone; the template `AGENTS.md` names `mcp-description.md`

## 4. Local bridge (hexis-mcp)

- [ ] 4.1 In `deployment.ts` add `resolveDeployment(config): Promise<{ mcpUrl, agentInstructions: boolean }>` from the one `/api/config` fetch; `resolveMcpUrl` becomes a wrapper returning `.mcpUrl` (public export, string consumers in `cli.ts` and `server.ts` unchanged)
- [ ] 4.2 Add `fetchAgentInstructions(config): Promise<string | undefined>` using `getJson`; a body without an `instructions` string, a non-2xx status or a network error logs one line and resolves to `undefined`
- [ ] 4.3 In `createHexisMcpServer` call `resolveDeployment`; when `agentInstructions` is true fetch before constructing the `Server` and pass `instructions`; when false log one line naming the older deployment
- [ ] 4.4 `catalog.test.ts`: `resolveDeployment` reports the flag present and absent beside the existing older-deployment case; `fetchAgentInstructions` on 200, malformed body, 500 and network error
- [ ] 4.5 `stdio.e2e.test.ts`: the initialize result carries the text when the fake deployment advertises the flag and serves the endpoint; carries none when the config has no flag; carries none when the flag is set but the endpoint answers 500

## 5. Frontend card (core-frontend)

- [ ] 5.1 Add `fetchAgentInstructions()` to a new `services/agent-instructions.api.ts`, calling `/api/agent/instructions` through `authFetch`
- [ ] 5.2 Add the "What connected agents are told" section to `ExternalAgentAccessPage.tsx` above the tab strip: "On connect" (instructions via `MarkdownRenderer`, `N / 6,000 characters`, clients that read the handshake) and "On the four knowledge-base tools" (prefix, `N / 300 characters`, clients that read only descriptions); truncation warnings for both; unterminated-comment warning; the sentence that every connected agent sees it whatever its access; loading and inline error states that leave the tabs working
- [ ] 5.3 Admins (`useContext(AdminContext)?.isAdmin ?? false`) get an Edit link to `kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/mcp-description.md`)` with `kbDirName` from `useWorkspace()`, rendered only when non-null; non-admins get the line saying admins edit it at the repository root
- [ ] 5.4 Regression: mock the new API module in the hoisted `vi.mock` set of `ExternalAgentAccessPage.test.tsx` and keep the card tolerant of absent providers so the 20 existing cases still pass
- [ ] 5.5 Component tests: both blocks and counts render; Edit link only for admins and only once `kbDirName` is known; truncation warning for each cap only when truncated; comment warning only when flagged; fetch error shows the inline message and both tabs still switch

## 6. Docs and release

- [ ] 6.1 README FAQ entry: "How does an agent know what is in the knowledge base?"
- [ ] 6.2 Rewrite the parenthetical in `packages/mcp-core/src/meta-tools.ts` (line 10-11): the header now arrives as initialize instructions; the code-mode protocol stays in the description because several clients drop that field; point at `modules/agent-instructions/compose.ts`
- [ ] 6.3 Changeset for the fixed version group per `.changeset/README.md`
- [x] 6.4 Fill `openspec/config.yaml` context so later changes start from the repository's conventions
- [x] 6.5 `TODOS.md` created by the engineering review with the deferred follow-ups

## 7. Verification

- [ ] 7.1 `pnpm typecheck`, `pnpm lint`, `pnpm test` green
- [ ] 7.2 Manual: connect Claude Code to a local deployment with `claude mcp add`, confirm the instructions appear in its MCP server instructions block, edit `mcp-description.md`, open a new session, confirm the edit is there
- [ ] 7.3 Manual: connect through `hexis-mcp` and confirm the same text arrives; point `hexis-mcp` at a config stub without the flag and confirm it starts with the one log line
- [ ] 7.4 Manual eval, recorded in the PR description: one fixed organisation-specific question asked in Claude Code, claude.ai web and Cline, with and without the preamble; note whether the first tool call is `start_session` or `grep`, and whether claude.ai shows the fixed line at the start of the four tool descriptions
