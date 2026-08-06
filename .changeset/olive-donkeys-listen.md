---
'@bevel-software/platform-core-frontend': patch
---

Right-click works in the Library nav, the way it already did in Knowledge's file
tree. It answered nothing before — no `onContextMenu` existed anywhere in
`GroupsSidebar`, so the gesture fell through to the browser's own menu on the
one surface that most looks like it should have its own.

The BEHAVIOUR is the file tree's, deliberately: the panel opens at the pointer,
an outside click or Escape closes it, and Escape hands focus back to the row it
came from — the same `useDismissableMenu` wiring, since `MenuPanel` is
presentation only and provides none of it. Two sidebars in one frame should not
answer the same gesture two different ways.

The ITEMS are the Library's own, because a group is not a file. A group row gets
`Add a skill or tool` · `New group` · `Copy link` · `Manage access`; a LENS row
("Owned by me", your own space) gets only the two that a slice of the catalog
can answer, since there is no folder and therefore no `access.md` behind a
slice — the same call `PageActions` already makes when it hides `Share` on the
personal page. The nav's empty space gets `New group` alone. Rename, Delete and
Download are deliberately absent: no endpoint stands behind any of them for a
group, and a menu item that cannot do its job is worse than one that is not
there.

`Manage access` stays ungated on `canWrite`, exactly as the group page's `Share`
is — for a non-writer the dialog renders read-only, which is precisely what "who
is this shared with?" should answer, and for an admin locked out of a group it
is the self-service way back in. Locked rows get the full menu for the same
reason they get the same click: a group you are not in is still a place.
