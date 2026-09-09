---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

The Skills & Tools sidebar is regrouped around who can use what. It opens on Everything, which now lists plugins as rows above the skill and tool cards, and Owned by me does the same for what you manage. Under "Your teams" sit your own space and every group from the access rules; a team's page shows the plugins, skills and tools that being in that group lets a person use, worked out by the same rules that decide access for its members — a plugin that admits the group, a role that lists it, a skill shared with the group's plugin. A team whose plugin locks its members out of a linked skill turns orange in the sidebar, as a plugin did. Under "Full file trees" the `Skills/` and `Plugins/` folders appear exactly as they are on disk, with the same rows as the Knowledge explorer; opening a skill file, a plugin manifest or a tool file lands on its page.

The all-plugins index and the per-plugin sidebar rows are gone — a plugin is reached from the page that lists it or from its folder in the tree — and the search box just says Search.

Behind it, `GET /api/teams` names what each group can read, sliced to what the caller already sees, and the platform no longer hides the `Plugins/` root from the file tree: the packaged template drops the rule, the first start after the upgrade removes every `Plugins/` line from an existing knowledge base's `.bevelignore` (the seed left no comment to tell the platform's line from a hand-written one, and hiding the root would empty the sidebar's tree), and the Groups→Plugins migration retires its old `Groups/` line instead of renaming it. Agents that list files see the plugins folder now; what they may read there is unchanged.
