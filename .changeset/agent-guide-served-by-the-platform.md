---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-frontend': minor
---

The agent guide is served by the platform, not written into the repository.

The guide every agent is told to read first — the layout, where a new file goes, the rules every file tool shares, access control, skills and tool manuals — used to be written to the top of every protected branch as `AGENTS.md` and refreshed on every start. A repository that already had an `AGENTS.md` of its own lost it, or had to give the platform's guide another name; a distribution that wanted to add to the guide had to carry a copy of the whole file, which then drifted from every change made here; and the file sat in git history on every branch, hidden by an ignore rule.

The guide is now composed from text that ships with the platform, at the moment an agent asks for it. A new `get_agent_guide` tool returns it, and a `read_file` of `AGENTS.md` at the repository root returns it too — after the repository's own `AGENTS.md`, whole, when it has one, with a marked separator between the two. `file_stat` on that name reports a readable text file that cannot be written, moved or deleted. A root `AGENTS.md` is the organisation's own page from now on: never written, never hidden, movable and deletable like any other.

The first start on this version removes the copies earlier versions wrote from every protected branch — only a copy that still carries the platform's own header, never a file someone edited — and takes the rule that hid them out of `.bevelignore`. A copy left on a draft is recognised the same way and never served.

The **Agent guide file** setting is retired, with the pointer sentence it offered to keep in a repository's own `AGENTS.md`. A deployment that saved a name keeps it as a read alias, so nothing it told its agents stops working.

For a distribution: `CorePorts.agentGuide` takes a function that receives the platform's sections and the layout and returns the sections the guide is composed from — append your own, replace one by id, or drop one — so every change to the rest of the guide reaches your deployments without a copy to maintain. A `kb-template/AGENTS.md` a distribution still ships is not seeded any more.
