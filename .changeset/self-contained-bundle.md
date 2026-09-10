---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

`hexis-all` is now a plugin of its own holding every skill the person may read and the knowledge base's MCP endpoint, instead of a manifest that only names the other plugins as dependencies. Only Claude Code resolves a dependency list; Cowork and claude.ai installed an empty plugin. One install now means the same thing on every surface. Codex's catalogue no longer lists the bundle, since Codex installs every entry on add and would have installed everything twice.
