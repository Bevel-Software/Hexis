---
'@bevel-software/platform-core-frontend': patch
---

A file inside a plugin says which plugin it belongs to. Opening a plugin's `plugin.json`, its `access.md` or any other file of its own in the Skills & Tools tree shows the file, as every file does, with one line above it naming the plugin and an **Open plugin** link to its page. The manifest no longer jumps to the plugin page on its own, which proved unreliable; the page still shows the manifest in its collapsible section.
