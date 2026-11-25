---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-shared': minor
---

One person's personal skill or tool no longer takes another person's away. A skill name is now unique per owner: two people may each keep a personal skill of the same name, and each lists and loads their own (a shared skill of that name still comes first for both, as before). A tool id is the secret-variable namespace the vault keys secrets by, so two people's personal tools with one id still cannot both be served; the one whose file landed on the default branch first (by git history; a file not committed yet counts as newest) now keeps it, instead of the one whose personal folder sorts first. The other is left out and reported in its owner's `invalid` list at its own path, with a reason that names no other manual or owner. When the history cannot be read, both are left out for that scan rather than one picked by path. `@bevel-software/platform-shared` adds `personalPluginFolderOf`, which gives the personal folder a path sits in.
