---
'@bevel-software/platform-core-backend': minor
---

The agent guide documents `- group:<Name>` entries in `roles.yaml`: how the group name is matched (case- and whitespace-insensitively, against `synced-groups.yaml` in IdP mode and `groups.yaml` otherwise), how group members combine with direct email members and with role denials (the nearest `access.md` decides; a person's own entry beats a role entry only within the same file), that a group under `Admin` makes every member a full admin, and how a non-admin proposes the edit through a change request. An agent write to `roles.yaml` that adds a group entry naming a group the active group source does not declare is now refused with a 422 naming the entry and its role, instead of saving an entry that silently gives the role to nobody. Entries already in the file are not re-checked, and an unreadable group source skips the check.
