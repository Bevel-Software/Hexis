---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

A file opens in the app its folder belongs to. Clicking a plugin's own file in the Skills & Tools tree — its `access.md`, its `plugin.json`, a stray upload — or a scope's file under `Skills/` now shows the file inside Skills & Tools, with that app's sidebar and toolbar around the same viewer Knowledge uses; it used to switch the whole screen to the Knowledge app. The tool page's "Edit the tool file" and the plugin page's manifest button stay in Skills & Tools the same way.

Every `access.md` the platform writes now explains itself in place. A fresh folder rules file — the one created when someone grants access on a folder that had none — carries the platform's two-block shape with a comment on each block: the top block governs the file, the body governs the folder; entries are a role, a group, a person, or `everyone`, the built-in org-wide principal for every signed-in person and their agents. The root template and the managed `AGENTS.md` say the same, including that `read: everyone` in a folder's body opens the folder to the whole organisation while the same line in a plugin file's top block only makes the plugin findable. The app shows an `access.md` as the YAML it is, so those comments read as comments rather than as headings.

A plain folder made under `Plugins/` is no longer turned into a plugin at the next start. The Groups→Plugins migration wrote a `plugin.json` into every folder directly under the root, so an empty folder from "New folder" — or a grouping folder holding plugins, which the manifest then hid — became a plugin on boot. It now applies the same rule as the manifests step: only a folder holding legacy plugin content, with no plugin beneath it, gets a manifest.
