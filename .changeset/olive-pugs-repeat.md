---
'@bevel-software/platform-core-frontend': patch
---

The settings pages keep a persistent nav. They were reachable only from the
profile dropdown, which closes on the way out — so moving between two of them
meant re-summoning a menu from the avatar. A pathless `SettingsLayout` route
now holds the nav across them, filling the app's existing sidebar frame (a
horizontal strip below `md`).

`AdminMenuItem` gains an optional `path` so a row can declare where it goes
rather than only perform it; rows that navigate via `onSelect` are unaffected
and stay dropdown-only.

Skills & Tools is no longer listed in the profile menu — it is an app, and the
app switcher already lists it and marks it as current.
