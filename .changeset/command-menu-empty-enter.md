---
'@bevel-software/platform-core-frontend': minor
---

The command menu no longer runs anything on Enter before something is typed. With an empty query no row is highlighted until ↓ or ↑ (↑ starts at the bottom) or the pointer picks one, and Enter with no row highlighted does nothing, so Ctrl/⌘K then Enter can no longer make a stray page from the suggested New page. Once there is a query, the best match is highlighted and Enter takes it, as before. Clearing the query clears the highlight.

The Actions group now shows up to twelve rows instead of eight, so a query like "settings" lists every settings page an admin has.
