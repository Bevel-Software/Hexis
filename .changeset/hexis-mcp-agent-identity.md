---
'@bevel-software/hexis-mcp': minor
---

A browser sign-in from the local server belongs to the agent that runs it. The server learns which one from the MCP handshake and registers with the workspace as, for example, "Claude Code · local server on your-machine" — which is how it appears on the workspace's Audit log page, and what is revoked there. Each agent on a machine signs in once, as itself, and keeps its own credential under `~/.hexis/oauth/`.

On the first start after upgrading, an existing keyless setup signs in once more, because the sign-in is now the agent's; its previous per-machine sign-in is then revoked at the workspace and removed from disk, so the old "hexis-mcp on your-machine" row ends on the Audit log rather than lingering. Key mode is unchanged. A client that hangs up during the sign-in, or a sign-in that fails, now ends the process as it did before.
