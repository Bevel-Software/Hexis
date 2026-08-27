---
'@bevel-software/platform-core-backend': patch
---

A whole-document configuration file's own `owner:` / `read:` / `write:` are now read even when the document uses YAML the access grammar's subset parser does not (folded `>-` descriptions, literal `|` blocks, nested maps). Before, such a file's verbs were silently dropped: a reviewed, merged `.tool` grant did not exist, and the file was unreadable by the very principal it named. The subset parser still answers first; the full parser is consulted only when it cannot, and only the top-level verb keys are used.
