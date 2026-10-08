---
'@bevel-software/platform-core-backend': patch
---

The `open_page` view's resource URI now carries a hash of the view's content (`ui://hexis/page-<hash>.html`). A chat host caches a view by its URI, so a changed view under an unchanged URI was served stale until the host happened to refetch — Claude kept rendering the view it had cached before #391, the one that goes blank. Every change to the view is now a new URI, so no host can keep serving the old one. The local MCP server forwards whatever URI the deployment serves and needs no change.
