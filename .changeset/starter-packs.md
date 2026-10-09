---
'@bevel-software/platform-core-backend': minor
---

Starter packs: a new knowledge base's admin can fill it with pages and skills that fit what the team does, in one commit.

A pack is a folder under `starter-packs/` (shipped in the package; a distribution points `STARTER_PACKS_DIR` at its own): a `pack.yaml` with `id`, `name` (the chip's label), `description`, `order`, `firstPagePrompt` and `suggestedPages`, beside `KnowledgeBase/`, `Plugins/` and optionally `Skills/` under the default folder names. A folder that does not read as a pack is skipped with a warning; the format is in `starter-packs/README.md`.

- `GET /api/onboarding/starter-packs` answers `{ offered, chosen, packs, chosenPack }`. `offered` is true for an admin while nobody has answered and the knowledge folder on the default branch still holds nothing but the starter guide. `chosenPack` carries the team's `firstPagePrompt` and which of its pages are still exactly as the pack wrote them.
- `POST /api/onboarding/starter-pack { id }` (admin only; 409 once the question is no longer asked, 404 for an unknown pack; `none` skips) adds the pack as ONE commit on the default branch, authored by the admin ("Add starter pages and skills for Sales"), through the same batch write the roles admin uses. Only paths that do not exist yet, judged with every lock held, are written, under the deployment's own names for the three folders. The pack's plugin is run by the admin: its `access.md` (the pack's own, or the one "Create a plugin" writes) names them under read, write and owner, and a plugin already there by that name is left alone. Open trees refresh through the usual `fs-tree-changed` event.
- The answer is kept in the new internal deployment setting `starterPack`, read from the database so every replica agrees. `DeploymentSettingsService.reload(key)` re-reads one plain setting for that.
- A pack's pages are short tasks to fill in, so while one still holds exactly what the pack wrote it does not end `start_session`'s `firstRun` note, which then names the pack's suggested pages. `registerWorkspaceTools` takes the source of that as a new optional last argument.
