# Source

The skills in this plugin are adapted from gstack, Garry Tan's set of Claude Code skills.

- Repository: https://github.com/garrytan/gstack
- Commit: `db745675bdf9f575276db2dcd132d3c047218a12` (v1.91.33.0)
- License: MIT, in `LICENSE` beside this file (Copyright (c) 2026 Garry Tan)

Skills taken: `office-hours`, `plan-ceo-review`, `plan-eng-review` and `review`. Their method is gstack's — the forcing questions, the premise challenge and alternatives, the review modes and sections, the cognitive patterns, the error and rescue map, the test coverage diagram, the pre-landing checklist and the fix-first heuristic — and much of the wording is too. `office-hours/sections/phase-2a-startup-diagnostic.md` and `phase-2b-builder-brainstorm.md` are gstack's text with only the question-tool references removed, and `review/checklist.md` is gstack's checklist with the specialist-reviewer column and one suppression removed.

Adapted for Hexis. gstack's skills are generated from templates and run inside a gstack install: every one starts with a preamble that calls gstack's own scripts (`~/.claude/skills/gstack/bin/…`: update checks, telemetry, session state, learnings, question preferences, review logs, a "brain" cache) and reads files gstack's `./setup` installs. None of that exists outside gstack, so each `SKILL.md` here was rewritten from its template as instructions that stand on their own:

- dropped the preamble, telemetry, learnings capture and search, question tuning, the review log and readiness dashboard, the brain cache and write-back, plan-mode gates and the self-check against generated sections;
- dropped the optional outside-voice review through the Codex CLI and the "Aside" browser research (web research now uses whatever search the agent has, with the same privacy rule), and office-hours' visual mockups, which need gstack's design binary;
- dropped office-hours' builder profile and founder-resources closing, and review's Greptile triage, parallel specialist reviewers, exploratory QA, slop scan and adversarial pass, all of which run gstack tooling;
- design docs, CEO plans and reviews are saved as pages in the Hexis knowledge base instead of `~/.gstack/projects/`, and earlier designs are found there;
- the long generated `review-sections.md` of each plan review was condensed into its `SKILL.md`;
- `allowed-tools` lists naming Claude Code's tools were removed, since Hexis matches that field against the tools in its own catalog.

Not taken: `ship`, whose core steps (the review readiness gate, `gstack-version-bump`, `gstack-evidence`, `gstack-review-read`) are gstack scripts installed by its setup; and `retro`, whose metrics come from gstack's `gstack-retro-metrics` and `gstack-global-discover` programs.
