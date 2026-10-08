---
'@bevel-software/platform-core-frontend': patch
---

A plugin's `plugin.json` reads as "Plugin settings" wherever the app names it: its row in the Plugins tree (and the row's menu), its tab, the page title, the bar above the file, a change request's file list and the version preview. Hovering shows the real file name. The file on disk, its URL and every API keep `plugin.json`, and a `plugin.json` that is not directly in a plugin's folder (a skill's example) keeps its name.

The plugin page's button is "Edit plugin settings" (was "Manifest") and its disclosure is "Plugin settings" (was "Manifest plugin.json"); the bundle format's `plugin.bundle.json` keeps its technical label.

`displayFileName(path)` and `fileNameTooltip(path)` in `shared/display-file-name.ts` are the one place that mapping lives.
