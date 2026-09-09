---
'@bevel-software/platform-core-frontend': patch
---

The Skills & Tools sidebar switches between its two views with an IdP Groups / Advanced toggle under Everything and Owned by me, instead of stacking both under headings. IdP Groups lists your own space and the groups from the access rules; Advanced holds the `Skills/` and `Plugins/` folders as they are on disk, with no heading over them. The view you pick is remembered in your browser. A new plugin is started by right-clicking any folder in the Plugins tree or the sidebar's empty space, or from the Everything page. Under the hood the file tree stays one component: a surface injects its own context-menu items, and "New plugin" is the Plugins tree's.
