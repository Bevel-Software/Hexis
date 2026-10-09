---
'@bevel-software/platform-core-backend': minor
---

An Engineering starter pack, for teams that answer "What does your team do?" with Engineering.

It brings four short pages to fill in (About us, How we ship, Architecture, Glossary), each a heading, a line on what belongs there, a few fields and a request to hand your agent, plus a first-page prompt that asks the agent to fill in Architecture from the repository. Its `engineering-starter` plugin carries four skills adapted from Garry Tan's gstack (MIT): `office-hours` to think an idea through before building it and save a design doc to the knowledge base, `plan-ceo-review` to pressure-test a plan's scope, `plan-eng-review` to lock its architecture and tests, and `review` for a pre-landing review of a diff. gstack's own machinery (its preamble scripts, telemetry, review logs, Codex and browser integrations) is left out, and so are `ship` and `retro`, which depend on programs gstack's setup installs. `SOURCE.md` in the plugin names the commit and what changed; `starter-packs/README.md` says how to refresh vendored skills.
