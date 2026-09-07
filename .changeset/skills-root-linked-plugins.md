---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-shared': minor
---

Skills have a home of their own, and plugins link to them instead of holding a copy. A new `Skills/` root stores shared skills organised by who owns them; a plugin lists the skills it uses in its manifest, so one skill can ship in many plugins. Who may read a skill comes from the skill's own access rules, and a plugin's members can be granted anywhere as `plugin/<Name>/read`, `plugin/<Name>/write` or `plugin/<Name>/owner`, the way a group is. Linking, requesting write access to a skill, and repairing a link all happen from the plugin and skill pages.

Skills also reach agents as native plugins: every user can clone a git remote from the external-agent access page that holds a plugin marketplace compiled from exactly what they may read, with a one-command install for Claude Code and Codex and a flat layout for the skills CLI. The knowledge base's MCP endpoint ships inside it.

A knowledge base laid out by someone else can be read in place: the three root folder names are settings, and plugins described by a `plugin.bundle.json` with an MCP registry are read read-only. On the first start after the upgrade, `Skills/` is created and every legacy plugin folder gets its manifest; nothing needs doing by hand.
