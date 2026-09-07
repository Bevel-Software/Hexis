---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-shared': minor
---

A plugin's `plugin.json` `name` is now its identity. It is what the marketplace publishes, what the plugin page's address and the API key on, and what grants spell: `plugin/<name>/read`, `plugin/<name>/write`, `plugin/<name>/owner`. The name must be a lowercase kebab-case identifier, as the Agent Plugins specification requires; a manifest whose name is not one is reported and the folder's name stands in. What people see is the manifest's `displayName`, or the folder name when there is none, so nothing is relabelled by the upgrade.

Managers can rename a plugin from its page: the display name freely, the identifier with every grant in the knowledge base that names it rewritten in the same change. The plugin's folder path is shown under its title and stays where it is.
