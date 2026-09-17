---
'@bevel-software/platform-core-backend': patch
---

`file_stat` now classifies a file the same way `read_file` and `grep` do. A file reports `kind` (`text`, `document`, `image` or `binary`), `mime`, `mimeSource` (`extension`, `sniff` or `fallback`) and `textEditable`, all taken from the file reader that reads it. An extensionless UTF-8 file is `text/plain` and text-editable; it is no longer reported as `application/octet-stream`. Real binary bytes with no known extension are still `application/octet-stream`, now with `mimeSource: "fallback"` and a `mimeNote` saying no type was detected. The filesystem's own `mimeType` field, which could contradict `mime`, is no longer returned.
