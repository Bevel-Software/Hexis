## Start here

You are connected to this organisation's knowledge base: its documents, and
the skills and tools its teams have approved, with access set per folder. To
the people you work with it is not a Git repository: say "knowledge base",
"draft" and "change request", and do not explain it as "a Git repo". If they
ask how it compares, see `for-git-users`.

**Read this once per conversation.** Then fetch only the section a task needs,
`get_agent_guide({ body: { section: "<id>" } })`, and do not reload the whole
guide. When you start a sub-agent, pass it the rules below and the one section
its task needs.

### Before your first call

- **Every file tool takes `branch`.** `{{defaultBranch}}` is the default
  branch: what is live for everyone. Work in progress lives on a draft branch.
  For example:
  `read_file({ body: { branch: "{{defaultBranch}}", path: "{{kbDirName}}/{{knowledgeBaseDir}}/Overview.md" } })`.
- **Copy each tool's `Call:` line.** The platform's own tools take their
  arguments under `body`; a tool from another service takes them flat. A call
  with a missing or unknown argument is refused, and the refusal shows the
  tool's interface.
- **Pass `sessionId` only where a tool lists it.** Over MCP, call
  `start_session` once and pass its id to the tools whose arguments include
  `sessionId`. Other tools refuse it.
- **`grep` takes RE2-style regular expressions** (ripgrep): no look-around
  and no backreferences.
- **Paths sit under `{{kbDirName}}/`**, as in
  `{{kbDirName}}/{{knowledgeBaseDir}}/Overview.md`. A path without that prefix
  is placed under it.

### Before you write to `{{defaultBranch}}`

A write there is live for everyone at once. Unless the person has already
said where, ask first: directly on `{{defaultBranch}}` (only when they may
write every file it touches), or on a draft with a change request.

### What is live, and what is only on a draft

Work on a draft is visible to you, and to anyone who opens that draft: in the
app, choose the draft in the branch switcher and it shows in Knowledge.
**Skills and tools go live only once they are on `{{defaultBranch}}`**,
merged through a change request or written there directly by someone allowed
to. Until then the app's skills page, `list_skills` without `branch` and the
tool list do not show them, and "doesn't exist" means "not merged yet". To see
a skill on a draft, pass the draft as `branch` to `list_skills` or
`get_skill`. People approve a change request and apply it in the app; no
agent tool does.

### A secret pasted into the chat

Do not repeat it, not even in part. Say it should be treated as exposed and
replaced, and where the new one goes: a shared value on the tool's page in the
app, a personal one on the Connect page. Never in the chat.

### Which section answers what

| Question | Section |
|---|---|
| What does my agent see when it connects, and how does it find the rest? | `how-agents-find-things` |
| How is this like Git, and how is it not? Why can't I delete this? | `for-git-users` |
| What is a plugin, a skill, a tool, a secret, a role, a group? | `glossary` |
| What do the platform's folders hold? | `directory-structure` |
| Where does a new file go? How do I lay out a team's first project? | `where-a-new-file-goes` |
| What may the file tools do: content kinds, write modes, moves, deletes? | `working-with-files` |
| Who may read or change what: roles, groups, `access.md`? | `access-control` |
| How do I propose, sync or delete a draft, or settle a conflict? | `drafts-and-change-requests` |
| How do I write a skill, or one for people who are not technical? | `skills` |
| When can I use a tool, and what does it need set up? | `tools` |
| How do I add a tool: `.tool` files, `mcp.json`, sign-ins? | `tool-manuals` |
| How do I build an interactive HTML page? | `html-views` |
| How are pages named, linked and sourced? | `conventions` |
| The knowledge base is empty: what now? | `new-knowledge-base` |

A deployment may add sections of its own: `sections` in this answer lists
every one. `get_agent_guide({ body: { section: "all" } })` returns the whole
guide.
