## Why

On 2026-10-19 an engineer at a customer (Unite) spent a nine-hour day building on the platform through Claude Code. His agent loaded the guide 15 times, about 100 KB each time on his workspace. Its first two reads failed (`branch` is required). It explained the platform as "a Git repo", got branches, deletes and per-folder access wrong, and nobody told him how an agent gets its context. He scaled his project down. The weekly sync on 2026-10-23 raised the same points: the platform feels too technical, Git analogies confuse the agent, access is per folder, skills and tools only load from the default branch, and the agent documentation has gaps.

The guide has no size limit, no idea of what an agent needs first, and nothing that fails when the code changes under it. Every section is served at once, so a question about one tool costs the whole guide. Tool descriptions already have a length cap (`description-length.ts`); the guide and the server instructions do not.

## What Changes

- A framework for what belongs in the guide: three layers (always loaded, first contact, on demand), a token budget per layer and per section measured with a real tokenizer, and a scoring rule that decides whether a piece of guidance goes in, in which layer, or out. See design.md.
- A small evaluation: ten first-contact tasks from that day, each with the facts the guide must let an agent get right, measured against the current guide.
- A short `start-here` section that `get_agent_guide` returns when no section is named, with the default branch named and a map of which section answers which question. The whole guide stays one call away (`section: "all"`); a `read_file` of `AGENTS.md` answers with the same start.
- New guide content for the gaps the customer hit, each placed by the scoring rule: the platform for Git users, how an agent finds things, a glossary, a starter layout for a team's first project, when a tool becomes available, skills that check their tools first, and guided skills for non-technical users.
- Every section, the server instructions and the tool descriptions checked claim by claim against the code, and corrected where they differ.
- CI checks in the existing `Test` workflow: the guide against the tool registry and `kb-layout.ts`, the budgets, and a snapshot of the tool surface that fails when tools or arguments change until the change is accepted, with a rule for coding agents to update the guide in the same pull request.

## Capabilities

### New Capabilities
- `agent-guide`: what the platform's guide holds, how it is layered and sized, what `get_agent_guide` returns, and the checks that keep it true to the code.

### Modified Capabilities

None.

## Impact

- **core-backend**: the guide's sections under `agent-guide/` (new, split, merged and rewritten), `modules/agent-guide` (the `start-here` default, the `all` section, a `{{defaultBranch}}` placeholder, the budget table), the `branch` argument description in `tool-helpers/tool-def.ts`, new tests beside the existing ones, and `js-tiktoken` as a dev dependency for the token counts.
- **Agents on every deployment**: `get_agent_guide` with no arguments answers with the short start section and the list of sections instead of the whole guide.
- **Distributions**: a hook that adds sections keeps working. Its sections are not covered by core's checks; a distribution can apply the same budgets to its own.
- **Repository**: an `AGENTS.md` at the root with the rule for coding agents.
