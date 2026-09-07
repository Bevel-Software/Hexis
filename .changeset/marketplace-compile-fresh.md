---
'@bevel-software/platform-core-backend': patch
---

A marketplace fetched within a minute of a knowledge-base change could come back without that change and then stay that way until the next change, because the compile stamped the new commit over catalogs cached before it landed. Each compile now reads the skill catalog, the plugin links and the access rules fresh from the checkout it stamps, so `claude plugin marketplace update` and `git pull` see a change as soon as it is committed.
