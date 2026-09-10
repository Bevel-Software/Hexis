---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

Skills & Tools: "Everyone" leads the Groups list, showing what is org-wide — the plugins, skills and tools every signed-in person and their agents can use, with no group or role needed. `GET /api/teams` opens with that entry, computed as the built-in `everyone` principal's own verdict (`canReadAsEveryoneBatch`) and sliced to what the caller already sees, like every group's. Your own space no longer has a row under Groups — it is a plugin, not a group — and stays reachable from its row on Everything, the Plugins tree and its URL.
