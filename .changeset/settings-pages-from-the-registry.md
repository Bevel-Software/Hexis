---
"@bevel-software/platform-core-frontend": minor
---

An app can add settings pages of its own. A profile-menu row (`AdminMenuItem`) that declares a `path` and a `page` is mounted inside the settings layout beside the built-in pages, and listed in the settings sidebar under its section, including a section the app defines itself (such as "Infrastructure only"). The row's `isShown` decides who sees it in the sidebar, as it does in the menu. Until now a row could open a dialog, run an action or name a path somewhere else in the app, but it could not bring a page into the settings screen. The built-in addresses stay the built-in pages': a row that names one (`/secrets`, `/connect` and the like), or a path an earlier row took, has its page neither mounted nor listed. Paths are compared as the router compares them, so `/SECRETS` and `/secrets/` name the `/secrets` page. A row that also opens a dialog or runs an action is not listed in the sidebar; it stays in the profile menu.

`isSettingsNavPath` takes the list of paths to judge against as an optional second argument (`useSettingsNavPaths()` gives the full list, built-in pages and the app's); with one argument it answers for the built-in pages as before.
