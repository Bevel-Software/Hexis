## Context

The hosted MCP proxy builds a fresh SDK `Server` per session in `packages/core-backend/src/modules/mcp/mcp.service.ts` (`createSession`) and passes only `capabilities`. The SDK (`@modelcontextprotocol/sdk` 1.30) accepts `instructions` in the same options object and returns it in the initialize result; `Client.getInstructions()` reads it back. Claude Code, Claude Desktop and Cursor place that text in the model's system prompt. claude.ai on the web, the Agent SDK and Cline drop it (anthropics/claude-ai-mcp #93, open), so the handshake alone does not reach the client the External agent access page advertises first. The one thing every client shows the model before it decides to call anything is the tool description, which claude.ai truncates near 500 characters. The comment in `packages/mcp-core/src/meta-tools.ts` still says "there is no system prompt over MCP"; this change adds that system prompt and keeps the code-mode protocol in its tool description for the clients that never see it.

Everything a hosted session needs that depends on the caller's access is fetched over loopback with the caller's bearer (`fetchManualTemplates`, `fetchSkillList`), so ACL filtering lives once behind the REST surface. The preamble is read with platform privileges, so that reason does not apply to it; the proxy reads it in-process. The local bridge (`packages/hexis-mcp/src/server.ts`) registers the hosted endpoint as a UTCP manual of type `mcp`; UTCP does not forward a remote server's instructions, so the bridge needs its own fetch, as it already does for skills through `callKbTool`.

The KB template ships a managed root `AGENTS.md` that `template-files.step.ts` rewrites on every boot and `.bevelignore` hides. Nothing reads it at runtime. It already tells teams to keep their own conventions in files of their own. `roles.yaml` and `groups.yaml` are the precedent for platform configuration that lives in the repository: root files, admin-only through the root `access.md`, edited from an admin page.

Deployment settings (`modules/settings/deployment-settings.service.ts`) are env-first, cached per process, treat a blank save as "keep", render as single-line fields and hold no history. They fit boot-time connection values, not a multi-paragraph text an admin revises.

The default-branch workspace is a working tree: the app's own commits and merges refresh it, and a push made directly to the git host appears on the next pull. Skills, tools and access rules are read from that tree with that freshness, and so is the preamble.

Stakeholders: KB admins who know what their repository holds; every user whose agent connects; the enterprise overlay, which plans an AX overhaul and will want to append its own graph-aware summaries.

```text
                 default-branch workspace
                 <kbDirName>/mcp-description.md
                              |
                     readAgentPreamble()           ENOENT: null   anything else: throw
                              |
                 composeAgentInstructions()        strip comments, cap 6,000 and 300
                              |
        +---------------------+------------------------+
        |                                              |
  McpService.createSession (in-process)        GET /api/agent/instructions (manualAuth, no-store)
        |                                              |
  Server({ instructions })                +------------+-------------+
  tools/list prefixes                     |                          |
  start_session, grep,              hexis-mcp                  card on External agent access
  list_files, read_file       (only when /api/config          "On connect"        N / 6,000
        |                      carries agentInstructions)      "On the four tools" N / 300
        |                                 |
  client honours the handshake?     Server({ instructions })
  yes: system prompt                      |
  no:  the prefix is still in       discovers tools from the hosted
       the four descriptions        listing, so it inherits the prefix
```

## Goals / Non-Goals

**Goals:**
- Every MCP session, hosted or through the local bridge, tells the model what Hexis is and to search the knowledge base before answering from memory, on every client, including the ones that drop the handshake.
- Admins write the per-deployment part themselves, per knowledge base, with history and review.
- One composer produces the text; the hosted proxy, the local bridge and the admin page all read its output.
- Zero admin work still improves every deployment (the platform header and the fixed prefix line alone).
- Bounded cost: the text lands in every conversation's system prompt and on four tool descriptions, so both sizes are capped and both are visible in the app.

**Non-Goals:**
- Per-user or per-plugin instructions scoped by access. Recorded in `TODOS.md`.
- An auto-generated index of readable folders or ontologies. Recorded in `TODOS.md`.
- Returning the text from `start_session` as a third channel. Recorded in `TODOS.md`, gated on the manual eval in this change.
- An inline editing form. The Knowledge editor already edits the file with locks and history. Recorded in `TODOS.md`.
- Moving the code-mode protocol out of the `call_tool_chain` description into the header. Dead: the clients that drop the handshake are the reason it must stay in the description.
- An adoption marker on a pre-existing `mcp-description.md`. Considered in review and rejected: a forgotten marker silently disables the feature, which is likelier than a root file with this Hexis-specific name that was not meant for Hexis. The card shows the broadcast text to every admin.

## Decisions

**1. Two channels: `instructions` on the initialize handshake, and a purpose prefix on four tool descriptions.**
The handshake is the channel Claude Code, Claude Desktop and Cursor inject without the model acting. claude.ai web, the Agent SDK and Cline ignore it, and tool descriptions are the only pre-call channel every client honours, so the hosted `tools/list` handler prepends a short prefix to the descriptions of `start_session`, `grep`, `list_files` and `read_file`, purpose line first because claude.ai cuts descriptions near 500 characters. The bridge discovers its tools from that listing, so it inherits the prefix. Every other tool's description is untouched. Alternatives considered: a prompt named `orientation` (invisible unless picked); a longer `start_session` description (already long, and still one tool); a plugin carrying a skill (reaches only readers of that plugin, right for team notes later, wrong for "what is this KB"); echoing the text from a tool result (arrives after the model has already decided whether to call the server; kept as a possible third channel in `TODOS.md`).

**2. Two layers: a code-owned header, then the admin's preamble.**
Notion, Sitefire and similar connectors send a static vendor string because every workspace on their product has the same shape. Hexis deployments do not, so the vendor writes only the mechanics and the "search here first" rule; the subject matter comes from the admin. The header, final:

> Hexis is this organisation's knowledge base, together with the skills and tools its teams have approved. Its content is specific to the organisation and is not in your training data. Before answering a question about the organisation, its people, customers, products, processes, projects or internal terms, search the knowledge base: call `start_session` once, then `grep` for the key terms, `list_files` to orient, and `read_file` what matches. Prefer what you find there over memory or the web, and say so when the knowledge base is silent on something the organisation should have documented. Skills are available as prompts and through `list_skills` and `get_skill`.

The tool prefix is a fixed imperative line, then the preamble's first non-heading paragraph, capped together at 300 characters:

> This organisation's knowledge base. Search it before answering from memory.

The fixed line always leads, so an admin's first edit never removes the instruction from the clients that only see the prefix, and a preamble that opens with a heading still yields a sensible purpose line.

**3. Source of the admin part: a file in the KB repository, not a database setting.**
Versioned, reviewable through change requests, exported with the repository, and something an agent can itself propose an edit to ("the KB gained a Permitting folder; add it to the preamble"). It is also the convention coding agents already use for instructions about a body of content (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`). A database setting would be simpler to build and is not wrong; it just discards the one advantage a git-backed knowledge base has here. Rejected: a section inside the managed `AGENTS.md` (rewritten every boot; marker-based partial rewrites are fragile). The file is read from the default-branch workspace with the same freshness as skills and access rules: app commits and merges refresh it; a direct push appears on the next pull.

**4. Location and name: `mcp-description.md` at the repository root.**
Root is where deployment-wide configuration already lives (`access.md`, `roles.yaml`, `AGENTS.md`), and the root `access.md` makes it admin-writable by default. Lowercase to match `access.md` and `roles.yaml`. Alternatives: root `README.md` (git hosts render it as the front page, but many repositories already carry one with unrelated content, and the name does not say agents read it); `KnowledgeBase/README.md` (visible to more readers, but it is content territory, and enterprise knowledge validation may treat it as a node). `.bevelignore` in the template does not list `mcp-description.md`, so admins see it in the tree and can open it in the editor. Inside the workspace the repository is the `<kbDirName>/` folder, so the read path is `${kbDirName}/mcp-description.md` and the editor URL is `kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/mcp-description.md`)`, the same shape `SkillService` and `PluginExtras` use.

**5. Read with platform privileges.**
The root is default-deny for reads, so reading as the caller would silently give non-admins nothing. The preamble is a broadcast the admin writes for every connected agent; the card says so in plain words. Folder names in the preamble can reach users who cannot read those folders. That is the admin's call, and the card states it. The same default means a non-admin cannot open the file in the editor; proposing a change through a change request needs root read, which an admin may grant deliberately.

**6. One pure composer, one reader, one route.**
`packages/core-backend/src/modules/agent-instructions/compose.ts` exports the header constant, the fixed prefix line and `composeAgentInstructions(preamble: string | null)`, which strips comments, applies both caps and returns `{ instructions, toolPrefix, truncated, preambleChars, unterminatedComment }`. A reader beside it ensures the default-branch workspace exists (`getOrCreateForBranch(DEFAULT_BRANCH)`) and reads the file: ENOENT is the only absence and yields `null`; any other error throws, the same contract as the plugin archive route. `GET /api/agent/instructions` mounts beside `all-tools` in `tool-manuals.routes.ts` under `manualAuth`, which accepts connection keys, internal tokens and browser JWTs, answers with the composer's result, and sends `Cache-Control: no-store` because the text is privileged. The route serves the local bridge and the frontend card. No separate service class: the reader is one function.

**7. The hosted proxy composes in-process at session creation, no loopback, no cache.**
`McpService` receives the reader at construction (wired in `create-core-services.ts` like `SkillService`) and calls it in `createSession`. A thrown read error falls back to the header and the fixed prefix line with a logged warning; a session never fails to initialise over its preamble. Loopback was considered and rejected: it exists to apply the caller's ACL once, and this read has no ACL, so it would only add a bearer, a failure path and a bounded timeout to the initialize path. An edit reaches the next session without a restart.

**8. The deployment advertises the capability; the local bridge fetches only when it is advertised.**
`GET /api/config` gains `agentInstructions: true`. `resolveDeployment(config)` in `deployment.ts` returns `{ mcpUrl, agentInstructions }` from the one config fetch the server already makes, and `resolveMcpUrl` remains as a wrapper returning `.mcpUrl` because it is a public export consumed as a string by the CLI. When the flag is present the bridge calls `GET /api/agent/instructions` before building its `Server` and passes the text as `instructions`; when absent it logs one line naming the older deployment and sends none. Any failure of the fetch itself (network, non-2xx, malformed body) logs and starts without instructions. A 404 heuristic was rejected after verification: an unknown `/api/*` path on an older deployment falls past the agent router into the JWT-protected mounts and answers 401, which `getJson` reads as an expired sign-in.

**9. Comment stripping, two caps, code-point cuts.**
HTML comments let the template explain itself and let admins keep notes without sending them to every agent. An unterminated `<!--` strips everything after it, so a private note can never leak on the most likely editing slip; the composer reports `unterminatedComment` and the card warns. The preamble cap is 6,000 characters, roughly 1,500 tokens, enough for a table of contents and conventions, small enough to sit in every conversation; over the cap the text is cut and a marker names the file to shorten. The prefix cap is 300 characters. Both cuts land on a code-point boundary, never inside a surrogate pair, so a multi-byte preamble truncates cleanly and the counts in the card match what the server sends. Counts are reported before truncation.

**10. Seeding: `REQUIRED_FILES`, never the managed refresh, and the template is one comment.**
`mcp-description.md` joins `REQUIRED_FILES` in `template-files.step.ts`, so a missing file is added on every protected branch at the startup phase and an existing one is left alone, like `access.md`. Only `AGENTS.md` gets the managed rewrite. The template file is a single HTML comment carrying the explanation and the starter skeleton, whose first line says that removing the wrapper broadcasts the text; a never-edited file therefore sends the header alone. An admin who wants no preamble empties the file; the top-up restores only a missing file. Every protected branch carries its own copy, as every root file does; MCP sends the default branch's copy, and an agent working in a clone reads the copy on its branch, which the `AGENTS.md` pointer says.

**11. The card lives on External agent access, above the tab strip, and shows both channels.**
It is the page where people connect agents, and it applies to both tabs. It calls the route with the session and shows two blocks: "On connect", the composed instructions with `N / 6,000 characters`, labelled with the clients that read the handshake; and "On the four knowledge-base tools", the prefix as it will appear with `N / 300 characters`, labelled with the clients that read only descriptions. It warns when either is truncated and when a comment is left open, and states that every connected agent sees the text whatever its access. Admins get an Edit link to the file on the default branch, rendered only once `kbDirName` is known; non-admins see the line saying admins edit `mcp-description.md` at the repository root. A failed fetch shows an inline message and leaves the tabs working.

**12. The stale comment in `meta-tools.ts` is rewritten in this change.**
It now says the header arrives as initialize instructions and the code-mode protocol stays in the tool description because several clients drop that field, with a pointer to the composer.

**13. Eval: manual before/after on the three clients that matter, plus deterministic assertions.**
One fixed organisation-specific question asked in Claude Code, claude.ai web and Cline with and without the preamble, results recorded in the PR description. A unit test pins that each prefixed description starts with the fixed line and that the prefix is at most 300 characters. An automated eval harness is recorded in `TODOS.md`.

## Risks / Trade-offs

- [Every conversation pays the token cost, twice over on the four tools] → two caps, two counts in the card, a short header, a shorter fixed line.
- [Folder names reach users who cannot read them] → documented in the card and the template comment; the admin decides what to name.
- [A client ignores `instructions`] → the prefix carries the imperative and the purpose line to every client; a `start_session` echo is recorded as a possible third channel.
- [A repository already has an unrelated root `mcp-description.md`] → it becomes the preamble and shows in the card on the first admin visit; an adoption marker was rejected as the likelier silent failure.
- [A direct push to the git host edits the file] → it appears on the next pull, the same freshness skills and access rules have.
- [A disk fault while reading the file] → the route answers 500, the proxy falls back to the header with a warning, the bridge starts without instructions and logs; absence and failure stay distinguishable.
- [Enterprise wants graph-aware summaries] → the composer is one function; a `CorePorts` seam can wrap it later without touching the transport.

## Migration Plan

Additive. On the first boot after upgrade the startup phase adds `mcp-description.md` to protected branches (one commit, like any other required file) and every new session carries the header and the fixed prefix line. `/api/config` gains a field older bridges ignore; a newer bridge against an older deployment starts normally and sends no instructions. Rollback is a code revert; the file stays in repositories and is harmless. No database change.

## Open Questions

All four were decided in the engineering review of 2026-09-04:

1. **Name and place**: root `mcp-description.md`, read at `${kbDirName}/mcp-description.md`.
2. **Privileged read**: everyone gets the whole text; non-admins cannot open the file under the default root policy.
3. **Editing door**: Edit link to the Knowledge editor; an inline form is in `TODOS.md`.
4. **`start_session` echo**: in `TODOS.md`, gated on the manual eval recorded in this change's PR.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | none |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 (plan outside voice) | ISSUES_FOUND | 8 findings, 5 accepted, 3 kept |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 11 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | none |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | none |

- **CODEX:** 8 outside-voice findings. Accepted: in-process composer call instead of loopback; fixed imperative leads the tool prefix; the card shows both channels with counts; `resolveDeployment` beside an unchanged `resolveMcpUrl`; `Cache-Control: no-store` and code-point-safe caps. Kept from the design: no adoption marker; seed every protected branch; freshness fixed as wording, not a per-read fetch.
- **CROSS-MODEL:** both reviewers agree on the `/api/config` capability flag, the comment-wrapped template, the read contract and the kbDirName paths; 5 of 8 outside-voice points changed the plan, 3 were rejected with reasons recorded above.
- **VERDICT:** ENG CLEARED: ready to implement. Design review recommended for the card before shipping.

NO UNRESOLVED DECISIONS
