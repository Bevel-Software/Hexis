---
'@bevel-software/hexis-mcp': patch
---

A connection key revoked while the local server holds it stops it at once. Before every `tools/list` and every tool call, local-only tools and the meta-tools included, the local server asks the deployment whether the key is still live (one read of `/api/agent/instructions`, on a deployment that advertises it). A refusal answers that call with "Invalid or revoked connection key. Mint a new one in External agent access.", runs nothing and sends no vault variable, then the server shuts down and the `hexis-mcp` command exits non-zero. A local tool used to keep running for up to five minutes on its cached variables, and forever when it had none. A deployment that cannot be reached, or answers 5xx, is not a revocation: the call goes ahead as before.
