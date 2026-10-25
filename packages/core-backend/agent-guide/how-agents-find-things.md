## How your agent finds things

Use this to know what you already have, and to explain it to the person you
work with when they ask "does the agent read everything?".

**When an agent connects, it has three things and no more:**

1. **The server instructions**: a short platform note, the rules every file
   tool shares, and this knowledge base's own description, which an admin
   writes in `mcp-description.md` at the repository root (on the app's
   external agent page). Claude Code, Claude Desktop and Cursor put them in
   the system prompt. Clients that drop them (claude.ai on the web, the Agent
   SDK, Cline) get one line and the description's first paragraph at the top
   of `start_session`, `grep`, `list_files` and `read_file` instead.
2. **The tool list**: each tool's name, description and arguments.
3. **The skills' names and descriptions**, as prompts and through
   `list_skills`.

**Everything else is fetched when a task needs it**: `grep` for the key terms,
`list_files` to see a folder, `read_file` for a page, `get_skill` for a skill's
instructions, and this guide one section at a time. No agent reads the whole
knowledge base, and nothing makes it look: the instructions ask it to search
before it answers about the organisation, and the rest is up to the text below.

**What brings the right context is text the agent already has:**

- **A skill's description** decides when the skill is loaded. Write it as
  "Use when …", in the words people use for the task.
- **Links between pages** (relative markdown links) lead one read to the next.
  A page that links the pages explaining it is found together with them.
- **`mcp-description.md`** says what this knowledge base holds, where, and
  when to look. Its first paragraph is the part every client sees.

**On the user's own machine**, the one text an agent always reads in a
repository is that repository's `AGENTS.md` or `CLAUDE.md`. A few lines there
make it look here first. Offer this, filled in:

```markdown
## Organisation knowledge
Before you plan, design or write about <product or team>, search the
<organisation> knowledge base (MCP server `<server name>`): grep for the key
terms and read what matches. <What> lives in `{{knowledgeBaseDir}}/<Folder>/`.
Prefer it over memory, and say when it is silent.
```

**This knowledge base's own conventions** go in an `AGENTS.md` at its root,
written by its people: `read_file` on `AGENTS.md` returns that file first, then
this guide. A `CLAUDE.md` at the root is theirs too. Follow both, and never
copy this guide into either: the platform serves it. Only the root file is read
this way: an `AGENTS.md` deeper in a folder is an ordinary page.
