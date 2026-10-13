---
'@bevel-software/platform-core-backend': minor
---

A knowledge base that is stopped — a workspace a multi-tenant host puts to sleep, or a server shutting down — now also stops the minute-by-minute check for plugin join requests still owed. Before, that check outlived the stopped knowledge base and kept asking a closed database every minute, one more time per workspace put to sleep, filling the log with a warning that showed a cut-off query instead of the reason. The log now names the database's reason; the person who asked to join sees one plain sentence when the database, not the git work, refused the request.

For a distribution that builds its own shutdown: the slot for the join-request jobs on `CoreStopDeps` / `ShutdownDeps` is now `pluginJoinRequestJobs`, the name the core services carry, not `backgroundJobs`. Rename it where you pass it, or the sweep is no longer stopped.
