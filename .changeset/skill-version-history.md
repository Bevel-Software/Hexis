---
'@bevel-software/platform-core-frontend': patch
---

A skill's version history is reachable again. The skill page now carries the same `⋯` menu a Knowledge page does, and its Version history opens the git log for the file on screen, in place of the reading pane, with a way back.

It was reachable from nowhere before. The shell routes every default-branch `Plugins/` URL to the library surface, so a skill file's only page is the skill page; the Knowledge tree does not list `Plugins/` at all, so there was no row to right-click either. The log had always been there behind the same endpoint the Knowledge viewer asks, and no screen asked it for a skill.

The menu is withdrawn while the editor is open, because the editor holds the draft in its own state and swapping it out for the log would discard whatever had been typed. It is absent entirely when git cannot answer, since Version history is the whole menu. History follows the file, not the page: switching to another file of the skill lands on that file's content.

Managing access is still the plugin's Share panel, unchanged — a skill inherits its plugin folder's `access.md`, and that is the one place those rules are set.
