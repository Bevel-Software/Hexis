## 1. Framework (openspec)

- [x] 1.1 Write the layers, budgets, scoring rule, evaluation and baseline (`openspec/changes/agent-guide-layers/design.md`), committed on its own

## 2. Guide text (core-backend)

- [x] 2.1 Check every claim of every section, the server instructions (`src/modules/agent-instructions/compose.ts`, `shared-file-rules.ts`) and the tool descriptions (`src/modules/*/**.tools.ts`, `tool-helpers/tool-def.ts`) against the code; correct the text, list code that looks wrong as questions
- [x] 2.2 Add `agent-guide/start-here.md`, `how-agents-find-things.md`, `for-git-users.md`, `glossary.md`, `drafts-and-change-requests.md`, `tools.md`; remove `introduction.md` and `finding-things.md`
- [x] 2.3 Rewrite `access-control.md`, `tool-manuals.md`, `directory-structure.md`, `where-a-new-file-goes.md`, `skills.md` to the scoring rule and their budgets; leave `html-views.md` to #451
- [x] 2.4 Point the `branch` argument at the guide (`src/modules/tool-helpers/tool-def.ts`)

## 3. Serving (core-backend)

- [x] 3.1 `CORE_SECTION_IDS`, the `{{defaultBranch}}` placeholder and `section: "all"` (`src/modules/agent-guide/agent-guide.ts`, `agent-guide.tools.ts`); the default answer is `start-here`
- [x] 3.2 Render the default branch from the knowledge base's branch model on each composition (`src/core/create-core-services.ts`)
- [x] 3.3 The budget table (`src/modules/agent-guide/guide-budget.ts`)

## 4. Checks (core-backend)

- [x] 4.1 `src/modules/agent-guide/__tests__/guide-budget.test.ts`: every layer and section against its budget, with `js-tiktoken` (dev dependency)
- [x] 4.2 `src/modules/agent-guide/__tests__/guide-matches-code.test.ts`: tools, arguments, call examples, paths, section ids, the start map
- [x] 4.3 `src/modules/agent-guide/__tests__/tool-surface.test.ts` and its committed snapshot
- [x] 4.4 `src/modules/agent-guide/__tests__/guide-eval.test.ts`: the ten tasks
- [x] 4.5 Share the catalog harness between these and `tool-registry/__tests__/tool-description-length.test.ts`

## 5. Repository

- [x] 5.1 `AGENTS.md` at the root: change behaviour, update the guide in the same pull request
- [x] 5.2 `docs/configuration.md`: what `get_agent_guide` returns now
- [x] 5.3 A changeset for core-backend
