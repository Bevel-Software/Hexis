## Skills (`{{skillsDir}}/<scope>/…/<skill>/SKILL.md`, or `{{pluginsDir}}/<Plugin>/skills/<skill>/SKILL.md`)

A skill is a folder holding a `SKILL.md` and whatever files it needs. Shared
skills live under `{{skillsDir}}/`, organised by ownership; a skill that belongs to
exactly one plugin may live inside that plugin's `skills/` folder instead.
Skill names are unique across the whole catalog, whichever home they have.
The frontmatter names it, declares which tools it may use, and may carry a
version:

```yaml
---
name: weekly-newsletter
description: Drafts the Friday newsletter for review.
allowed-tools: [slack_post_message]
metadata:
  version: "1.4.0"
---
```

The body is the instructions, in plain markdown. `allowed-tools` entries are
tool names from the `.tool` manuals and MCP servers of the plugins that hold
the skill, and the agent client's own tools beside them (`Bash`, `Read`,
`Bash(git:*)` and the like, which the platform leaves to the client).
`metadata.version` is semver; `list_skills` reports it, and
`get_skill` with a `version` loads the skill as it was when it last declared
that version (omit `version` for the latest). Any other `metadata` keys are
the author's own notes — the catalog carries the file as it is and acts on
none of them.

A `SKILL.md` committed on the default branch is listed and loadable from the
very next `list_skills` or `get_skill`, on the connection you already have:
the released catalog is cached briefly and dropped the moment the default
branch changes, so the next request reads the workspace again.
See *A released tool or skill is live within ten seconds* under **Tool
Manuals** for the one caveat (an MCP client that caches the prompt list it
was given at connect time must re-list — the prompt-list-changed notification
that tells it to arrives with the connection's next catalog check, which is
within ten seconds on a connection in use and at its next use on an idle
one).

**How skills reach agents.** Through the MCP server (`list_skills`,
`get_skill`), or as native plugins: every user can clone a git remote from
the app's external-agent page that holds a plugin marketplace compiled from
exactly the skills they may read — one plugin per plugin here, a
`skills-and-knowledge` plugin for the rest plus this knowledge base's MCP
server, and `hexis-all`, one plugin holding every skill they may read and
the MCP server, for a single install.
