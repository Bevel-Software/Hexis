---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

Plugins read from a customer's bundle format keep more of what the customer wrote, and say what they could not keep. An MCP registry's servers are now called by their `name`, the namespace a skill's tool calls are written against, and selected by `id`, so two transports of one server present as one; a profile that picks both is reported and the nearer profile's wins. Every server field the platform does not judge (`startup_timeout_sec`, say) rides through to the compiled `mcp.json`, and a bundle's `author`, `keywords` and `interface` block reach the compiled manifests, with the presentation block in the Codex one. A plugin folder's own files — a `CONVENTIONS.md` the skills refer to — ship beside the skills. A plugin nested below the plugins root can be archived by its identity. And what discovery left out of a plugin — a server the registry rejected, a skill root that is not a folder — is listed on the plugin's page in plain words and counted as attention on its row, instead of going to the server log alone.
