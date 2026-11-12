---
"@bevel-software/platform-core-frontend": minor
---

An app can add settings pages of its own. A profile-menu row (`AdminMenuItem`) that declares a `path` and a `page` is mounted inside the settings layout beside the built-in pages, and listed in the settings sidebar under its section, including a section the app defines itself (such as "Infrastructure only"). The row's `isShown` decides who sees it in the sidebar, as it does in the menu. Until now such a row could only open a dialog.

`isSettingsNavPath` takes the list of paths to judge against as an optional second argument (`useSettingsNavPaths()` gives the full list, built-in pages and the app's); with one argument it answers for the built-in pages as before.
