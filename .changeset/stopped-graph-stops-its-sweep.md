---
'@bevel-software/platform-core-backend': patch
---

A knowledge base that is stopped — a workspace a multi-tenant host puts to sleep, or a server shutting down — now also stops the minute-by-minute check for plugin join requests still owed. Before, that check outlived the stopped knowledge base and kept asking a closed database every minute, one more time per workspace put to sleep, filling the log with a warning that showed a cut-off query instead of the reason. The warning now names the database's reason.
