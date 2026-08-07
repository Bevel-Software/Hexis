# Groups/

One folder per **group**. A group holds the skills *and* the tools that belong
to it, side by side. Not part of the knowledge graph; access-controlled like
any other files.

Skills and tools live together because they share one access boundary: a tool
a group cannot read is a skill that group cannot run. Keeping them under
separate roots meant writing the same permission twice and letting the two
drift apart.

## Structure

```text
Groups/
├── <Group>/
│   ├── access.md           ← who can read/write everything in this group
│   ├── <skill-name>/
│   │   ├── SKILL.md        ← frontmatter (name, description) + instructions
│   │   └── <bundled files> ← optional templates, scripts, checklists
│   └── <tool_name>.tool    ← one manual per external API / MCP server
└── personal-<user-id>/     ← one per person: their own skills and tools,
    └── <skill-name>/          private by default, never listed as a group
        └── SKILL.md
```

Skills are discovered **by name** regardless of nesting (`list_skills` /
`get_skill`); bundled files are fetched with `get_skill`'s `file:` parameter.

## What goes here

- **One folder per group**, named the way the group reads to a human (`GTM`,
  `Engineering`, `Everyone`). Groups are created through the app (or its API),
  which seeds the folder's `access.md` — that file is the point of the folder:
  it makes the group discoverable and names its creator as the one who runs
  it. Names starting with `personal-` are reserved for the personal folders
  below.
- **One personal folder per person** (`personal-<user-id>/`), created
  automatically the first time they make a skill of their own. Its `access.md`
  names only its owner, so it is invisible to everyone else and never appears
  in the group list. A personal skill moves into a group by moving its folder.
- **One folder per skill**, holding a `SKILL.md` whose frontmatter declares
  `name:` (unique) and `description:` (when to use it). Quote the description
  if it contains a colon followed by a space — unquoted, that sequence breaks
  YAML parsing.
- **One `.tool` file per integration** — a UTCP manual (inline / http / mcp)
  the MCP/UTCP endpoint loads for anyone who can read it. Credentials bind to
  the Secrets Vault by variable name; never write a secret into the file.

The same integration may exist in several groups as separate files.
`Everyone/notion.tool` and `Finance/notion.tool` are two tools, each with its
own credentials and its own access rule. That duplication is deliberate: a
group is a folder, not an entry in a registry of unique names.

Write skills as instructions to the executing agent: what to load, what to do,
what to record, and the exact output contract expected of the run.
