---
read: everyone
---

# Agents

An `.agent` file describes one agent: who it is, what it runs on, and what it
may load. Put one anywhere in the knowledge base; this folder is the usual
place. Who may read, change or own the file is set the way it is for any other
file, with `read:`, `write:` and `owner:` in its definition or in an
`access.md` above it.

## The file

One `---` fenced YAML definition at the top, free prose after it:

```yaml
---
name: release-helper
description: >-
  Prepares release notes and checks the deploy dashboards. Reads; never writes.

# What a pipeline runner starts the agent with. The platform reads none of these.
harness: claude-code
model: claude-opus-5-5
harnessTools: [Read, Grep, Glob, mcp__hexis]

# What a connection made as this agent loads. Each list only narrows.
platformTools: [start_session, read_file, grep, list_files, list_skills, get_skill]
connectors:
  - Plugins/Engineering/tools/deploy-dashboard.tool
skills:
  - Skills/Release
plugins:
  - Plugins/Engineering/software.bevel.release

write: Developer
---

Notes about the agent, for people.
```

### The lists

Four plain lists, each named by what it holds. Every entry is a path in the
knowledge base, from its root, except `platformTools` and `harnessTools`,
which hold tool names. A folder means everything under it.

| Key | What it holds | Absent |
|-----|---------------|--------|
| `harnessTools` | The tools the harness gives the session (its own, like `Read` or `Bash`, and the MCP servers it mounts). Read by the runner that starts the agent; the platform ignores it. Called `tools.allow` before; runners still read that name until every file has moved. | Up to the runner |
| `platformTools` | Names of the platform's own tools, as `tools/list` shows them: `read_file`, `grep`, `list_skills`, … It decides which tools the agent is offered, not which skills it has: the skills the other lists name are its prompts either way. Written with no value (`platformTools:` or `platformTools: []`), it offers no platform tools. | Every platform tool |
| `connectors` | `.tool` files and MCP server definitions (`mcp.json`). A folder means every connector under it. | No connectors |
| `skills` | Skill folders. A folder above several means every skill under it. | No skills |
| `plugins` | Plugin folders. Each loads the plugin's connectors and skills, including the skills its manifest links from elsewhere. A folder above several means every plugin under it. | No plugins |

The connection loads the union of what the lists name. A list written as a
single string is a list of one. A list that is something else (a number, a
map) makes the file invalid, so a typo never loads more, or less, than you
meant without saying so.

`name` and `description` are what the "Connect as" choice shows. Without a
`name`, the file's name is used.

## Connecting as an agent

When you connect an MCP client (Claude, Cursor, Claude Code) to the
knowledge base, the consent step asks what to connect as:

- **Everything**, selected by default: every tool, skill and plugin you may
  read. This is how every connection worked before agents could be chosen,
  and it still works exactly that way.
- **One of the `.agent` files you may read**, by name with its description.
  The connection then loads only what that file's lists name.

The same choice is offered when you create a connection key on the External
agent access page. The choice is shown beside the key there, and beside the
connection and the key in the Audit log.

### What the platform guarantees

- **An agent only narrows.** Every item a list names is loaded only if you
  may read it, checked each time, as you. Naming a plugin you may not read
  loads nothing for it and is not an error. No list can give a connection
  something your own access does not.
- **The file is the configuration.** It is read again whenever the
  connection's tools are built, so an edit reaches every connection made as
  the agent at the next catalog revision, without reconnecting.
- **A missing agent fails closed.** If the chosen file is deleted, you can no
  longer read it, or it is not a valid definition, the connection loads
  nothing at all and says why, in its tool listing and in the text it
  receives at the start of a session. It never falls back to Everything.
  Reconnect and choose again.
- **Everything outside the lists is refused by name.** Every tool, skill and
  prompt listing reflects the agent: `tools/list`, `tools_info`,
  `list_skills`, `get_skill`, `prompts/list`, `list_tool_setup` and
  `list_local_tools`. A call to a tool the agent does not load is answered
  that the tool is not available to this connection, naming the agent.
  The one exception is a direct REST call to `list_skills` or `get_skill`:
  those two routes are also how prompts are read, so they answer with the
  agent's skills (exactly its prompts) even when `platformTools` does not
  offer them as tools.
- **The code-mode tools stay.** `call_tool_chain`, `tools_info` and their
  siblings are how a connection calls its tools, not tools of their own: they
  are offered to every connection that loads anything, and they reach only the
  tools the agent loads.
