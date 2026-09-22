---
'@bevel-software/platform-core-frontend': patch
---

In the Manage access sheet's new-grant checklist, unticking Can edit (or Owner, or Can download) leaves Can read selected instead of clearing it too.

Read was shown as checked only because edit implied it, so turning edit off dropped the selection to nothing and the Share button went dark. Less than edit is read: the tier below stays selected in its own right, and only the Can read item itself takes read away.
