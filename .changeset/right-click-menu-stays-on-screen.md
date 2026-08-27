---
'@bevel-software/platform-core-frontend': patch
---

The file tree's right-click menu now lands on screen.

Its panel was pinned to the raw pointer position, so a right-click low in the
sidebar drew the menu downward off the bottom of the window. Nothing brought
the lost rows back, because the panel is `position: fixed`: the page will not
scroll to a fixed box, and the wheel scrolls the tree out from under a menu
that stays where it was. A folder's menu is nine rows and roughly 300px tall,
which put `Manage access`, `Rename` and `Delete` below the fold for any
right-click in the lower quarter of the tree. That `Manage access` row matters
most: for a folder it is the only route to access control in the product, since
folder sharing was deliberately moved off the file page and onto the folder's
own row.

The menu is now measured before it paints. It still opens down and to the right
of the pointer, flips above when it will not fit below, and sits against the
bottom margin when the window is shorter than the menu itself. A menu that is
open when the window resizes is placed again against the new viewport, so
zooming or entering fullscreen no longer leaves it hanging off the edge. `EditorTabs`
had solved half of this on its own and now shares the placement, so a pointer
menu's behaviour no longer depends on which surface opened it.
