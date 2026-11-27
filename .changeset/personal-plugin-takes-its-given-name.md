---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-shared': minor
---

A person can name their personal plugin, and the app shows that name. `my_plugin` takes an optional `name`. It is stored as the manifest `displayName`: written into the new manifest when the folder is created, or into the existing manifest (other fields kept, one commit) when the folder is already there. A blank name is refused. The same name again writes nothing. A `plugin.json` that is not a JSON object is refused rather than overwritten. If the commit fails, the old manifest is put back. The new `GET /api/plugins/personal` returns `{ name }`: the manifest `displayName` the owner gave, or `null` when the manifest still carries the folder's own label or the person has no personal folder yet. It only reads and never creates the folder. So a `displayName` written into `plugin.json` by hand counts too. In Skills & Tools, the personal plugin's card and the heading of `/skills-and-tools/yours` show that name, and "Personal plugin" when none was given. They pick up a new name when the Library reloads. The breadcrumb on an item page and the search palette still say "Personal plugin". `renderPluginManifest` takes an optional display name for a folder whose leaf is not a typed name.
