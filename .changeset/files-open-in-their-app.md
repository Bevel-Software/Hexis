---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

A file opens in the app its folder belongs to. Clicking a plugin's own file in the Skills & Tools tree — its `access.md`, its `plugin.json`, a stray upload — or a scope's file under `Skills/` now shows the file inside Skills & Tools, with that app's sidebar and toolbar around the same viewer Knowledge uses; it used to switch the whole screen to the Knowledge app. The tool page's "Edit the tool file" and the plugin page's manifest button stay in Skills & Tools the same way.

A plain folder made under `Plugins/` is no longer turned into a plugin at the next start. The Groups→Plugins migration wrote a `plugin.json` into every folder directly under the root, so an empty folder from "New folder" — or a grouping folder holding plugins, which the manifest then hid — became a plugin on boot. It now applies the same rule as the manifests step: only a folder holding legacy plugin content, with no plugin beneath it, gets a manifest.
