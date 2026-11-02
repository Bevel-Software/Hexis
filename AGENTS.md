# Working in this repository

For coding agents (Claude Code, Codex, Cursor and others) and the people who
run them.

## Change behaviour, update the agent guide in the same pull request

The platform tells every connected agent how it works: the guide in
`packages/core-backend/agent-guide/` (served by `get_agent_guide`), the
handshake instructions in `packages/core-backend/src/modules/agent-instructions/`,
and each tool's description and arguments. When you change something an agent
can observe (a tool, an argument, a refusal, a path, an access rule, what a
draft or a change request does), update that text in the same pull request.

- `packages/core-backend/src/modules/agent-guide/__tests__/` holds the text to
  the code: every tool, argument, path and section the guide names, the token
  budgets in `guide-budget.ts`, the ten evaluation tasks, and a snapshot of the
  tool surface (`tool-surface.json`).
- A change to the tools or their arguments fails the snapshot. Update the guide
  if agents need to know, then accept the new surface:
  `pnpm --filter @bevel-software/platform-core-backend exec vitest run src/modules/agent-guide -u`.
  If no guide change is needed, say so in the pull request description.
- Before you add guidance, apply the scoring rule in
  `openspec/changes/agent-guide-layers/design.md`: is there evidence an agent
  gets it wrong; can it learn it from the tool's description or error instead;
  is it true for every deployment; what does it cost; is it already said? Say
  each thing once.
- A section that needs more room raises its budget in `guide-budget.ts`, with
  the reason in the pull request.
- Bevel's team: before changing any of this text, run the agent-guide
  benchmark (private, in `bevel-platform` at `evals/agent-guide/`) with the
  change against its base, and say in the pull request what it found.

Prose in the guide follows the house style: plain, short sentences, no em
dashes.
