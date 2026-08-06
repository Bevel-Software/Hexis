# KnowledgeBase/

Curated knowledge, organized as **ontologies** — one per team or domain.

## Structure

```text
KnowledgeBase/
├── <Ontology>/           ← e.g. "Product", "Engineering"
│   ├── NodeTypes/        ← node type definitions for this ontology
│   │   └── NodeType.md   ← the meta type (every ontology carries its own copy)
│   ├── Knowledge/        ← the knowledge nodes
│   └── access.md         ← optional ontology-root access rules
└── <AnotherOntology>/
```

Any direct subfolder containing BOTH `NodeTypes/` and `Knowledge/` is picked up
as an ontology by the platform's parser, validator, and access control.
Ontologies are **self-contained**: each carries its own `NodeTypes/NodeType.md`
and its own concrete types.

## What goes here

- **Typed knowledge nodes** in `Knowledge/`: markdown files opening with a
  frontmatter block declaring `nodeType:` (a quoted markdown link to the type)
  and a unique lowercase-kebab `id:`. Fields are headers matching the type
  definition; references to other nodes are file-relative markdown links.
- **Node type definitions** in `NodeTypes/`: one file per type, following the
  meta `NodeType.md` format.
- Markdown files *without* a `nodeType:` frontmatter are ignored by the parser
  (notes, scratch docs) — allowed, but invisible to the graph.

Conventions (naming, child-node folders, Source of Information blocks,
cross-ontology links) are documented in the repo-root `AGENTS.md`.

**Not for agent output**: records produced by agents and pipelines (work
items, instances, transcripts) belong in the `Data/` base folder, not here.
