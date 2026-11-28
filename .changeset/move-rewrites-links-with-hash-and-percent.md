---
"@bevel-software/platform-shared": patch
---

A link that `move_file` rewrites to a name holding `#`, `%` or `?` now percent-encodes those characters, so it resolves to the moved file instead of starting a fragment or carrying invalid percent-encoding. Bare and angle-bracket links otherwise keep their form.
