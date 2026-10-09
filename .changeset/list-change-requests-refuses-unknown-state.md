---
'@bevel-software/platform-core-backend': patch
---

`list_change_requests` refuses a `state` it does not know instead of answering the open ones.

The answer spells an applied request `state: merged`, so an agent that copied that word back into the filter was quietly given the open requests and read it as "nothing was merged". Any value other than `open`, `closed` or `all` is now refused with a 400 that names the three, on every surface the handler serves.
