---
"@bevel-software/platform-core-backend": minor
"@bevel-software/platform-core-frontend": minor
"@bevel-software/platform-shared": minor
---

A git host can now tell Hexis the repository changed. `POST /api/sync/<branch>`, called by a GitHub Action, an Azure DevOps service hook, a GitLab webhook or a pipeline step with the new `KB_SYNC_SECRET`, pulls that branch's clone and announces the new tree to open browsers, agents and the skill, tool and plugin catalogues — so a push made outside Hexis, or a pull request completed on the host, shows up at once instead of at somebody's next save. `POST /api/sync` with a webhook payload, an explicit branch list or no body covers hosts that cannot put the branch in the URL. The response names what happened to each branch, and a pipeline's `curl --fail` fails exactly when Hexis is not in sync. A branch whose Hexis-side commits clash with the host takes the same road as any other update: the deterministic rebase first, then the background recovery ladder — and until that has cleared it, the sync answers 409 and the branch shows a banner naming the files, each a link, so a person can settle it by hand.
