---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-shared': minor
---

Another person's personal plugin (`Plugins/personal-<id>/`) no longer gives away what it holds. `list_files` leaves the shelf out of the `Plugins/` listing for everyone who may not read it, and every path inside it answers the same 404 `not_found` as a missing path. `get_skill` on a skill there answers `not_found`, as for a name nobody used, instead of `forbidden`. The owner, and anyone they share the shelf with, list and load as before. Folders outside personal shelves are listed as before, and an ordinary skill the caller may not read still answers `forbidden`. `@bevel-software/platform-shared` adds `isInPersonalPluginDir`, which applies the `isPersonalPluginDir` rule to any path inside a shelf.
