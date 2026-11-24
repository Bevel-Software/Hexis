---
'@bevel-software/platform-core-frontend': patch
---

When opening a change request tries to bring it up to date and the server refuses on conflicts, the dialog now names the files the server reported. The banner lists them under "The file(s) that can't be combined", by the name the file tree shows (the full path on hover), the tree marks each one, and the prompt the banner offers to copy lists them in a data block of their own, marked as data and not instructions. Before, the dialog dropped the list the refusal carried, and neither the banner, the tree nor the prompt said which file conflicted. A refusal from an apply attempt reaches the dialog without a file list, so it names no file, as before.
