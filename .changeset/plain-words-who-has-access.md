---
'@bevel-software/platform-core-frontend': patch
---

A folder's `access.md` reads as "Who has access" wherever the app names it: its row in the tree (and the row's menu), its tab, the page title, the bar above the file and a change request's file list. Hovering shows the real file name; the file, its URL and every API keep `access.md`.

Opening one says what it is: "This file controls who can see and change Legal. Change it with Manage access.", with a Manage access button that opens the sheet for that folder (the same one its row in the tree opens). Share in the page header still manages access to the page itself.

Approving a file nobody may approve now says "No one can approve this file yet: nobody has edit access to its folder. Ask an admin to change who has access." instead of naming `access.md` rules.
