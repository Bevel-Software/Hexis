---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-mcp-core': patch
---

Every agent file tool now states the same content rule, and `tools_info` returns it: `read_file` returns text for text files and extracted text for documents; `write_file`, `write_files` and `edit_file` accept text only; `copy_file`, `move_file`, `delete_file` and `unzip` act on bytes of any kind; new binary content arrives through upload. The text tools refuse documents, images, archives and other binary files with status 415 and a body of `{ error, kind: "binary_not_writable", fileKind, useInstead: ["upload", "copy_file", "move_file"] }`. Images and archives are refused by name now, so text can no longer be written to `logo.png` or `bundle.zip`. Over MCP the refusal message keeps these fields. `file_stat` on a file reports `contentMode` (`text`, `document` or `binary`), so an agent can decide before it acts.
