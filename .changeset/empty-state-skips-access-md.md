---
'@bevel-software/platform-core-frontend': patch
---

The empty state's opening suggestions no longer offer `access.md` files. They are a folder's access-control rules, not pages to read — and because every plugin and governed folder carries one inside the knowledge tree, the existing root-file exclusion never reached them.
