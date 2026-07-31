# Skills/

Reusable **agent skills** — packaged instructions an agent loads when doing a
specific kind of work. Not part of the knowledge graph; access-controlled like
any other files.

## Structure

```text
Skills/
├── <skill-name>/
│   ├── SKILL.md          ← the skill: frontmatter (name, description) + instructions
│   └── <bundled files>   ← optional templates, scripts, checklists the skill uses
└── <grouping>/           ← subfolders for organizing are allowed
    └── <skill-name>/
        └── SKILL.md
```

Skills are discovered **by name** regardless of nesting (`list_skills` /
`get_skill`); bundled files are fetched with `get_skill`'s `file:` parameter.

## What goes here

- One folder per skill, holding a `SKILL.md` whose frontmatter declares
  `name:` (unique) and `description:` (when to use it). Quote the description
  if it contains a colon followed by a space — unquoted, that sequence breaks
  YAML parsing.
- Bundled assets next to the `SKILL.md`: HTML templates, checker scripts,
  reference files. Keep them small and self-contained.

Write skills as instructions to the executing agent: what to load, what to do,
what to record, and the exact output contract expected of the run.
