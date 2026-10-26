---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-mcp-core': patch
---

The agent guide is layered and true to the code. `get_agent_guide` with no `section` now answers with a short `start-here` section (the default branch every file tool takes, the first-call rules, and which section answers which question) and the list of sections; `section: "all"` returns the whole guide, as a `read_file` of `AGENTS.md` still does. Sections may use `{{defaultBranch}}`, rendered from the knowledge base's branch model each time the guide is composed (`AgentGuideContext.defaultBranch`).

New sections: `start-here`, `how-agents-find-things`, `for-git-users`, `glossary`, `drafts-and-change-requests` and `tools`. `introduction` and `finding-things` are gone, folded into them; `access-control` and `tool-manuals` are split. A distribution's hook that refers to a section by id should check the new list (`CORE_SECTION_IDS`); `directory-structure` keeps its id. Every section, the handshake's shared rules and several tool descriptions were corrected against the code (`share_current_branch` takes `branch`, `sessionId` goes only to the tools that list it, a spill ref still needs an existing `branch`, and more).

From a benchmark of agents working against both versions: the write tools and the start section say to ask the person before writing to the default branch; `list_tool_setup`'s `note` now also names the tools that need the caller's own value or sign-in, and says to set it on the Connect page and reconnect; and the guide spells out the draft name the platform reads as its author (`paul.brandt@` gives `paul-brandt/`).

Token budgets per layer and per section are in `guide-budget.ts` and held by tests, with the guide checked against the tool registry and `kb-layout.ts`, and the tool surface kept as a snapshot that fails until a change to it is accepted.
