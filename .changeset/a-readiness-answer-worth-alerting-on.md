---
'@bevel-software/platform-core-backend': patch
---

A new `GET /api/ready` reports the facts `/api/health` never carried. The health check answers `ok` whenever the process is up, which meant a deployment had no way to say it had stopped committing: a queue that no longer drains looks exactly like an idle one from outside. The readiness answer computes, on each request, whether the database is reachable, how old the oldest commit still waiting is and whether this process is the one draining, whether the last attempt to reach the git host succeeded and how long ago, and how much space is left on the volume holding the workspaces.

The one number worth paging on is the age of the oldest waiting commit. Past ten minutes the answer reads `degraded`; at a healthy pace a save lands in seconds, and a backlog of minutes means either nothing is draining or the remote is refusing it. Under a gibibyte of free disk degrades the answer too.

Only an unreachable database returns a 503. Everything else stays 200 with `degraded` in the body, deliberately: an orchestrator treats a failing readiness probe as a reason to restart, and a restart fixes none of the other conditions while dropping every request in flight. Those are conditions to alert on, and the numbers are there for that. During a redeploy the replacement process reports `draining: false` while the outgoing one still holds the lease; that is the designed state and does not degrade the answer.

The endpoint is unauthenticated, as a probe has to be, and discloses only booleans, ages and byte counts — nothing that names a person, a path or a workspace. `/api/health` is unchanged; the deploy pipeline and the container health check keep reading it.
