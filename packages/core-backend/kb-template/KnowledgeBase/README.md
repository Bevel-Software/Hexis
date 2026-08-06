# KnowledgeBase/

The knowledge itself. Organise it however suits the material.

## Structure

There isn't one. Folders, file names, how finely a subject is split — all of it
is a judgement call about what the next reader needs, not a rule the platform
enforces. A sensible starting point is one folder per team or domain:

```text
KnowledgeBase/
├── Product/
│   ├── Roadmap.md
│   └── Pricing/
│       └── Enterprise-Tiers.md
├── Engineering/
└── access.md             ← optional: who may write in here
```

## What goes here

Markdown, written the way the subject wants to be written — prose, tables,
checklists, diagrams. Nothing parses these files into a schema or rejects one
for having the wrong shape.

Two conventions are worth keeping, because they are what make a pile of
documents navigable:

- **Link between documents** with `[Page Name](relative/path/to/Page.md)`,
  relative to the linking file's own directory, so links resolve both in the
  app and on the git host.
- **Say where a claim came from** — a person, a ticket, a document, a URL —
  near the claim, with the date it was true.

An `access.md` at any depth narrows or widens who may write below it; see the
repo-root `AGENTS.md`.

## Deployments that add structure

Some installations layer a typed knowledge graph over this folder, where a
document declares a type in its frontmatter and the platform validates it
against a definition. That is not part of this platform: where it exists it
arrives with its own tooling and its own conventions, and the files it adds are
still ordinary markdown to everything here.
