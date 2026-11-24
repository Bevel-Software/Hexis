---
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-shared': patch
---

Saving a file edited in the app keeps its line endings. A `<textarea>` hands its text back with LF endings, so a CRLF file saved from the file page's editor was rewritten on every line, and a one-word edit showed as a whole-file change. The renderer the file page and the embed mount (`pickFileRenderer`) now hands its edits back with the file's own endings: lines before the first changed line and after the last keep theirs byte for byte, and the lines from the first changed line to the last take the ending most of the file's lines use (on a tie, the file's first). A CRLF file stays CRLF and an LF file stays LF. The skill page's editor, which had its own conversion, uses the same helper. The shared package exports `restoreLineEndings` and `dominantEol` (the access model's majority rule, moved there unchanged).
