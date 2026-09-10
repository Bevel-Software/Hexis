---
'@bevel-software/platform-core-frontend': patch
---

Dialogs and menus dismiss more precisely. A drag that starts inside a dialog and releases on the backdrop (selecting text and overshooting the edge) no longer closes the dialog, and when two menus are open at once — reachable with the keyboard — Escape closes them one at a time, newest first, instead of both on one press.
