# Knowledge base

This is a git-backed knowledge base. You are the primary agent responsible for
maintaining it.

> **This guide is served by the platform.** It is not a file in the
> repository: `get_agent_guide` returns it, whole or one section at a time,
> and so does `read_file` on `AGENTS.md` at the repository root — after the
> knowledge base's own `AGENTS.md`, when it has one; `grep` searches it there
> too. An `AGENTS.md` you find on disk is the organisation's own conventions
> file, written by its people; follow it, and never write this text into it.
> Deployment- or team-specific conventions belong there, or in files of your
> own anywhere under `{{knowledgeBaseDir}}/`, linked from wherever they are
> needed.

**Read `mcp-description.md` at the repository root first.** It says what this
knowledge base contains and when to consult it. Agents connected over MCP
receive the default branch's copy inline at the start of every session; a
clone reads the copy on its own branch.

**There is no required format for knowledge.** Write markdown the way the
subject wants to be written: prose, tables, checklists, diagrams, whatever
serves the reader. Nothing here parses your files into a schema or rejects a
document for having the wrong shape. If a deployment layers a structured
knowledge graph on top, it brings its own conventions, in sections of this
guide of its own; what follows describes the platform underneath, which stores
files and controls who may change them.
