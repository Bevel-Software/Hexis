# Data/

What agents **produce and consume** — split out of the curated
`KnowledgeBase/` so machine-generated records never entangle with curated
knowledge. Dashboards and the fleet view read from here.

## Structure

Parsed **exactly like `KnowledgeBase/`**: direct subfolders are ontologies,
each self-contained with its own `NodeTypes/` and `Knowledge/`. (A repo may
also use `Data/` itself as one single ontology by giving it `NodeTypes/` +
`Knowledge/` directly.)

```text
Data/
├── <Domain>/             ← mirrors the team/domain split, e.g. "Engineering"
│   ├── NodeTypes/        ← types for data records (work items, instances, …)
│   └── Knowledge/        ← the data nodes themselves
└── <AnotherDomain>/
```

## What goes here

- **Work items / tickets**: typed nodes an agent or pipeline picks up and
  drives (status, assignee, acceptance criteria).
- **Pipeline instances**: one node per run — current step, STATE, attempts,
  verdicts, links to its artifacts. Updated in place per transition; the
  node carries *current state*, git history carries *history*.
- **Intermediate outputs** that dashboards need.
- **Transcripts, probes, logs**: **plain files** (no `nodeType:` frontmatter)
  filed as children of their instance (`<Instance>/transcripts/…`,
  `<Instance>/probes/…`). Git-versioned and viewable in the app, but never
  part of the graph payload — long histories stay out of dashboards' way.

Rules of thumb: executor/runner processes write here (their access is
typically scoped to Data paths); humans intervene by editing nodes, and those
edits are treated as authoritative input. Machine-owned fields (e.g. a
runner's STATE) are owned exclusively by their writer — human input goes in
the record's designated notes field instead.
