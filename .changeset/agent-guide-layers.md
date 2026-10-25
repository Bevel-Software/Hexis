---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-mcp-core': patch
---

The agent guide is layered and true to the code. `get_agent_guide` with no `section` now answers with a short `start-here` section (the default branch every file tool takes, the first-call rules, and which section answers which question) and the list of sections; `section: "all"` returns the whole guide, as a `read_file` of `AGENTS.md` still does. Sections may use `{{defaultBranch}}`, rendered from the knowledge base's branch model each time the guide is composed (`AgentGuideContext.defaultBranch`).

New sections: `start-here`, `how-agents-find-things`, `for-git-users`, `glossary`, `drafts-and-change-requests` and `tools`. `introduction` and `finding-things` are gone, folded into them; `access-control` and `tool-manuals` are split. A distribution's hook that refers to a section by id should check the new list (`CORE_SECTION_IDS`); `directory-structure` keeps its id. Every section, the handshake's shared rules and several tool descriptions were corrected against the code (`share_current_branch` takes `branch`, `sessionId` goes only to the tools that list it, a spill ref still needs an existing `branch`, and more).

Token budgets per layer and per section are in `guide-budget.ts` and held by tests, with the guide checked against the tool registry and `kb-layout.ts`, and the tool surface kept as a snapshot that fails until a change to it is accepted.
