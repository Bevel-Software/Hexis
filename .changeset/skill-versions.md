---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': patch
---

Skills carry a version an agent can ask for. `list_skills` reports each skill's current `version`, read from its SKILL.md frontmatter: `metadata.version` first (the Agent Skills field), then a top-level `version`, then `lifecycle.version`. `get_skill` takes an optional `version`; given one, the skill (or the bundled `file` asked for) is served as it was at the most recent default-branch commit whose SKILL.md declared that version, and a version the skill never declared answers `version_not_found` together with the versions it did declare, newest first. Without `version` the skill loads as it is now, which is the latest. `GET /api/skills/:name?version=` takes the same option. A skill created from the library now starts with `name`, an empty `description` and `metadata.version: "1.0.0"` in its frontmatter, so it has a version from its first commit.
