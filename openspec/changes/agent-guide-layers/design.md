## Context

What an agent reads about the platform comes from three places:

- **Server instructions**, sent on the MCP handshake (`modules/agent-instructions/compose.ts`): a fixed platform header, the rules every file tool shares (`shared-file-rules.ts`), then the admin's `mcp-description.md`. Claude Code, Claude Desktop and Cursor put them in the system prompt; claude.ai on the web, the Agent SDK and Cline drop them.
- **The tool list**: each tool's name, description and input schema. Every client shows these before the first call. Descriptions are capped at 1,200 characters (`tool-registry/description-length.ts`).
- **The guide**, composed from the section files in `packages/core-backend/agent-guide/` plus the shared rules, and served by `get_agent_guide` or a `read_file` of `AGENTS.md`. Today `get_agent_guide` with no arguments returns all of it. A distribution can add sections through a hook; the enterprise distribution adds five.

The customer's day (Unite, 2026-10-19, written up in the Bevel knowledge base at `Product/Knowledge/Customer-Success/Unite/Onboarding/Onboarding-Learnings-2026-10-23.md`) is the evidence this change works from.

### How tokens are counted

With `js-tiktoken` and the `o200k_base` encoding. It is a real BPE tokenizer, deterministic and offline, so CI can run it. It is not Claude's tokenizer, which is not published for offline use; Claude models usually count somewhat more tokens for the same English text. The budgets are therefore ceilings to compare against each other and over time, not a model's exact bill. Characters are not used: markdown tables, code and backticks cost very differently per character.

### Baseline (dev at 9419298a, default layout)

| Layer | What | Characters | Tokens |
|---|---|---|---|
| Always | Server instructions: header and shared rules (no admin preamble) | 7,782 | 1,852 |
| Always | Tool list as served: 41 tools, name, description and input schema | | 15,829 |
| First contact | Nothing short exists: `get_agent_guide` returns the whole guide | 78,706 | 19,342 |
| | The same on an enterprise deployment, with its five sections | about 114,000 | 28,007 |

(Measured the way `guide-budget.test.ts` measures: the sections composed for a
default branch named `main`, each tool through `toListedTool` as the hosted
endpoint lists it.)

| Section | Tokens | | Section | Tokens |
|---|---|---|---|---|
| `introduction` | 342 | | `skills` | 689 |
| `directory-structure` | 2,009 | | `tool-manuals` | 5,678 |
| `where-a-new-file-goes` | 536 | | `html-views` | 2,683 |
| `working-with-files` (computed) | 1,688 | | `conventions` | 423 |
| `access-control` | 4,852 | | `finding-things` | 68 |
| | | | `new-knowledge-base` | 373 |

Enterprise sections (bevel-platform, not in this repository): `ontologies` 1,929, `node-format` 1,412, `graph-rules` 1,256, `knowledge-graph-layout` 1,134, `html-views` 2,934.

The customer's agent called `get_agent_guide` 15 times across the session and its sub-agents: about 420,000 tokens of guide, most of it never needed.

## Layers and budgets

| Layer | What it is | Who pays, how often | Budget (o200k tokens) |
|---|---|---|---|
| **Always** | Server instructions (platform part) | Every conversation on clients that honour them | 2,000 |
| **Always** | The platform's own tool list as served | Every conversation, every client, every sub-agent | 16,000, and 1,200 characters per description (unchanged) |
| **First contact** | `start-here`: what `get_agent_guide` returns with no section | Once per conversation and per sub-agent | 1,200 |
| **On demand** | Every other section, fetched by id | Only the tasks that need it | 2,500 per section; `html-views` 3,000 (open work in #451 grows it) |
| **On demand** | The whole guide (`section: "all"`) | An agent that asks for everything; the enterprise in-app agent's prompt | 19,000, below today's 19,341 although content is added |
| Per task | `start-here` plus the sections it routes a task to | One task | 6,000 |

The admin's preamble keeps its own cap (6,000 characters, `PREAMBLE_CAP`). Each budget is a number a reviewer may move, like the description cap: the point is that growing the guide is a decision, not a paragraph someone appends.

A distribution's sections follow the same per-section budget. Core cannot see them, so a distribution enforces it in its own repository (the enterprise `html-views` is over it today).

## The scoring rule

Ask, in order, of any piece of guidance:

1. **Evidence.** Would an agent get it wrong without it? Cite the evidence: a transcript, a real error, a support thread. Observed beats plausible. Nothing without at least a plausible failure goes in.
2. **Just in time.** Can the agent learn it at the moment it needs it: the tool's `Call:` line or input schema, its description, the error or refusal it gets, a field in the answer, or a section it fetches for that task anyway? Then put it there and nowhere higher.
3. **Scope.** Is it true for every deployment? Only for some: it belongs in the distribution's own section or the admin's `mcp-description.md`. Only for one organisation: it belongs in their knowledge base.
4. **Cost.** Tokens times how often the layer is loaded. A line in the always layer costs every conversation; a line in an on-demand section costs only the tasks that fetch it.
5. **Once.** Is it already said? Say each thing once, in the cheapest layer that reaches the agent in time, and point to it by section id elsewhere.

Placement follows from the answers:

- **Always**, only if the agent needs it before its first call or on most calls, cannot learn it just in time, and it is true everywhere.
- **First contact**, if most conversations need it in their first minutes, or a mistake would be costly or visible to the user (first-call errors, the Git analogy, what is live and what is only on a draft), plus the map of sections.
- **On demand**, for everything a specific kind of task needs.
- **Out**, if it fails 1 or 3, if it is mechanism the agent cannot act on (cache timings, why a design was chosen), if it is guidance for people rather than agents (the human onboarding guide), or if it asks for a product change.

## Evaluation

Ten tasks from the customer's day. For each, the facts the guide must let an agent get right. "Today" counts the facts the current guide states correctly and findably (yes / partly / no), and where they are. A fact stated only in passing, or only by implication, is "partly".

| # | Task (time on 2026-10-19) | Facts | Today (y/p/n) | Where today |
|---|---|---|---|---|
| 1 | What is this knowledge base, and how does my agent get its context? (09:05, 10:20, 14:52) | It is the organisation's knowledge base plus its approved skills and tools, reached over MCP, not "a Git repo" · on connect the agent has the instructions (platform note and the admin's `mcp-description.md`), the tool list, and skill names and descriptions · everything else is fetched when a task needs it, never the whole repository · skill descriptions and links decide which context arrives · a line in the user's own `AGENTS.md` or `CLAUDE.md` is the one text always present, with a snippet | 0 / 3 / 2 | introduction, finding-things |
| 2 | Read a page, list a folder (first calls, 09:05) | Every file tool needs `branch`, and which branch holds what is live · paths sit under `knowledge-base/` · `sessionId` only where a tool lists it · copy the tool's `Call:` line · `grep`'s pattern dialect (RE2-style since #462; before it, a JavaScript regex that refused `(?i)`) | 2 / 1 / 2 | directory-structure, tool-manuals, the tool schemas |
| 3 | Make a skill on my branch and see it (11:26 to 13:13) | Where a skill lives · frontmatter is YAML: quote a value that contains `: ` · on a draft the files are there, shown in Knowledge when that branch is selected · the skill catalog (app, `list_skills`, prompts) shows only what is merged · tools likewise | 2 / 1 / 2 | directory-structure, skills, tool-manuals |
| 4 | Why can't I delete this? (15:11) | On a draft you may change or delete anything you can read, and nobody else sees it until it is merged · on a protected branch you need write on every file a change touches, otherwise propose · some platform files are never deleted · `file_stat` says `deletable` and why · what you cannot read you cannot change | 4 / 1 / 0 | access-control, working-with-files |
| 5 | Is this like Git? Who merges? (10:20) | Branches are drafts, the default branch is protected · the agent opens a change request, a person approves and merges it in the app · access is per folder, with an example · on your draft anything goes, merge is where owners approve · saving commits and shares at once, the agent has no git · do not explain it as "a Git repo" | 2 / 3 / 1 | access-control, introduction |
| 6 | Set up a team's first project (11:26, 14:52, sync) | Where documents, skills and tools go · a starter layout, one question in one place · a folder can be restricted · search before creating · ask when the place is unclear | 3 / 1 / 1 | where-a-new-file-goes, conventions, access-control |
| 7 | Plugin, MCP server, tool, skill, secret, OAuth, role, group, `access.md`: what is each? (09:28, 10:56) | One fact per term, nine | 8 / 1 / 0, spread over 12,539 tokens | directory-structure, tool-manuals, access-control |
| 8 | I merged a tool; when can I and Langdock use it? (15:56 to 16:46) | Served from the default branch only · then each person signs in or sets a personal secret on the Connect page · then the client lists tools again, or reconnects if it caches · a connection-key client is served only tools whose personal secrets are set · `list_tool_setup` shows what is missing | 4 / 0 / 1 | tool-manuals |
| 9 | Make my skill check its tools first (10:56, sync) | Name the tools in `allowed-tools` · start with `list_tool_setup` and stop with a plain instruction when something is missing · never ask for a secret in the chat | 2 / 0 / 1 | skills, tool-manuals |
| 10 | A guided skill for a non-technical colleague (15:56) | One question per message · proposals they confirm or correct · a checklist for "specified enough" · plain words, no platform terms · it reaches them only after merge | 0 / 1 / 4 | skills |

**Today: 27 of 53 facts stated (12 partly, 14 missing).** No task can be answered without loading the whole guide, because nothing says which section answers what: 19,342 tokens per task on core, 28,007 on an enterprise deployment. An agent that guessed the right sections from their titles would still load between 410 and 12,539 tokens and miss the facts above.

**Target:** every fact stated, each task answered by `start-here` plus at most two sections, within 6,000 tokens. The evaluation becomes a test (`guide-eval.test.ts`): for each task, `start-here` routes it to its sections and those sections state each fact.

## After

Measured the same way, on this change's last commit (after merging `dev` at `39625e93`, whose tmp-folder rule adds about 95 tokens to the shared rules and 115 to the tool list):

| Layer | Before | After | Budget |
|---|---|---|---|
| Server instructions (platform part) | 1,852 | 1,969 | 2,000 |
| Tool list as served (41 tools) | 15,829 | 15,710 | 16,000 |
| First contact (`get_agent_guide` with no section) | 19,342 (the whole guide) | 1,061 (`start-here`) | 1,200 |
| The whole guide (`section: "all"`) | 19,342 | 18,620 | 19,000 |
| A `read_file` of `AGENTS.md` | 19,342 (the whole guide) | 1,268 (`start-here` and the list) | |
| One evaluation task | 19,342 | 1,061 to 3,479 | 6,000 |
| Evaluation facts stated | 27 of 53 | 53 of 53 | all |

| Section | Tokens | | Section | Tokens |
|---|---|---|---|---|
| `start-here` | 1,061 | | `drafts-and-change-requests` | 1,503 |
| `how-agents-find-things` | 659 | | `skills` | 1,026 |
| `for-git-users` | 641 | | `tools` | 952 |
| `glossary` | 584 | | `tool-manuals` | 2,354 |
| `directory-structure` | 1,356 | | `html-views` | 2,683 |
| `where-a-new-file-goes` | 702 | | `conventions` | 445 |
| `working-with-files` (computed) | 1,777 | | `new-knowledge-base` | 379 |
| `access-control` | 2,496 | | | |

The customer's fifteen guide loads would now cost about 16,000 tokens instead
of about 420,000. On an enterprise deployment the whole guide is about 27,000 tokens;
its five sections are unchanged and outside core's checks.

## Decisions

### 1. `get_agent_guide` with no section returns `start-here`

The first-contact layer only exists if the first call returns it. Every tool description opens with "Call `get_agent_guide` first", and agents (and their sub-agents) obey it on every start, so the default answer is the most-read text the platform has. It becomes the `start-here` section with the list of every section (`sections`, as today). `section: "all"` returns the whole guide. A `read_file` of `AGENTS.md` answers with the same start and the list (after the organisation's own file), so no read hands an agent the whole guide unless it asks for it.

Alternative: keep the whole guide as the default and put `start-here` first. Rejected: the agent still pays for the whole guide on each call, which is exactly the 15-load failure.

### 2. The guide names the default branch

The first two reads failed for want of `branch`, and nothing tells an agent which branch is live. Sections may use `{{defaultBranch}}`, rendered from the knowledge base's branch model each time the guide is composed (it can change at setup). The `branch` argument's description points at the guide.

### 3. Sections

`start-here` is new and first. `introduction` and `finding-things` fold into `start-here` and a new `how-agents-find-things`. New: `for-git-users`, `glossary`. `access-control` splits into access rules and `drafts-and-change-requests`; `tool-manuals` splits into `tools` (when a tool is available, setup, secrets) and `tool-manuals` (the file formats). `where-a-new-file-goes` gains the starter layout; `skills` gains "check your tools first" and guided skills. `directory-structure` keeps its id, which the enterprise hook places its layout section after. `html-views` is left to #451.

### 4. Drift checks

In the existing `Test` workflow, all as vitest tests in core-backend:

- **Guide against code.** Every tool, argument and result field the guide and the server instructions name exists in the tool registry; every call example (`tool({ ... })`) uses real arguments and all required ones; every platform path and file name matches `kb-layout.ts`; section ids and files match both ways; `start-here` maps every section.
- **Budgets.** Each layer and section measured with the tokenizer, failing with the section's name and count.
- **Tool surface snapshot.** The platform's tools, their arguments, which are required, and their enum values, as a committed file. A change to tools or arguments fails until the snapshot is updated (`vitest -u`) in the same pull request, which is where the author either updates the guide or says no guide change is needed. A pull-request diff rule ("tool files changed, guide did not") was the alternative. It fires on every refactor of a tool file, needs the base branch and an escape label, and does not run on push. The snapshot fires only when what agents see changes.

### 5. A distribution routes its own sections

`start-here`'s table routes core's sections. A distribution that adds a section sets `asks` on it, the question it answers, and the composition adds that row to the table. Without it, an agent that reads only the start section never learns the section is there except from the list of ids.

### 6. Asking before writing to the default branch

In the benchmark, agents wrote to the default branch without asking even where the guide said to ask. The rule is said where the agent is when it matters: on the four write tools behind almost all such writes, in `start-here`, and in the handshake header, which reaches an agent that never fetches the guide.

### 7. What the second benchmark round changed

On ten harder tasks, agents went wrong in three places the guide's text invited, plus one it never covered. The access section showed rules on one line (`read: everyone`), which an `access.md` body does not accept, so agents that copied it broke the file; it now shows the list form. Agents stated who has access from one folder or without the group file; the section now says to look it up per folder and to name who gains and who loses. `start-here` said a person "merges" in the app, whose buttons say Approve and Apply changes, and agents repeated that word; it now uses the app's. And agents repeated a key pasted into the chat; `start-here` now says not to, and where the new one goes.

### 8. Out of scope

Rows of the learnings page that ask for product changes (draft skills in the app, split error messages, defaults for `branch`, `sessionId` tolerance, secret format checks) and for the human onboarding guide are listed in the pull request, not built here. The enterprise sections are bevel-platform's.

## Risks / Trade-offs

- **An agent that needs the whole guide makes a second call.** The `start-here` map names the sections, and `section: "all"` is one call.
- **The checks read prose.** Identifiers are found by pattern (backticked or snake_case words, call examples). A word that is not a tool must be declared in the test's list of known non-tool words, with a reason. That list is the cost of catching renamed tools and arguments.
- **The snapshot can be accepted without thought.** It shows the change in the diff, where reviewers see it, and the repository rule asks for the guide in the same pull request.
- **o200k is not Claude's tokenizer.** Counts are relative, see above.
