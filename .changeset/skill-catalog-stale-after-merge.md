---
'@bevel-software/platform-core-backend': patch
---

Approving a proposed skill now puts it in the library straight away, instead of making it disappear for up to a minute first. The two halves of the catalog went stale at different speeds: the moment the merge landed the change request closed, so the skill dropped off the review shelf at once, while the released catalog kept serving its pre-merge scan until a 60-second TTL ran out — leaving the card the reviewer had just approved in neither list, and no amount of refreshing brought it back any sooner. The catalogs dropped their caches on a commit and on a working-tree write, but a merge writes the default branch through neither of those, so nothing told them anything had changed. A merge now drops them too, before the browser is told to reload, and the skill, tool-manual and plugin-index caches are wired from one place so a future path onto the default branch cannot refresh some of them and leave the rest a minute behind.
