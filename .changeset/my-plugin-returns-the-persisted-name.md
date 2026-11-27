---
'@bevel-software/platform-core-backend': patch
---

`my_plugin` now returns the personal plugin's `name` as its manifest says it, as it already did for `displayName`. When the personal folder already existed, the answer built `name` from the folder (`personal-<id>`), so a manifest whose `name` had been edited came back with two names that disagreed. Both ensure paths that find the folder, the existence check and the lost creation race, now read both fields through the shared readers discovery uses (`pluginIdentityOf`, `pluginDisplayNameOf`). A manifest `name` that is not a plugin identifier is not echoed: the folder's identity stands in, as discovery lists it. The folder, its access rules and its owner are unchanged.
