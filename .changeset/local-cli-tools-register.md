---
'@bevel-software/hexis-mcp': patch
---

The local server's `.tool` manuals register their cli tools again. The deployment hands a local-only `.tool` over as an http manual reference, and UTCP's secure default limits a manual's tools to the protocol of the template that registered it — so every cli tool was dropped at registration with only a per-tool warning on stderr, and a session connected to the local server never had `git.push` at all. Local http references now allow `cli` alongside `http`: the deployment refuses to execute cli tools and this process is where they are meant to run. An explicit `allowed_communication_protocols` on a template is respected unchanged, and the remote manual keeps the strict default.
