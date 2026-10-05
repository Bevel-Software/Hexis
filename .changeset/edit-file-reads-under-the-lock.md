---
'@bevel-software/platform-core-backend': patch
---

`edit_file` now looks for `old_string` in the file as it is when the write lands. The file is read, judged, the replacement computed and the result written with the file's lock held, so nothing can change the file in between. Before, the tool read the file first and took the lock only for the write: two callers replacing the same text were both told their edit had landed, and the second silently overwrote the first. Now the second is answered `old_string not found in the file.` and the first caller's edit stays. An edit to text that is still there keeps whatever else was changed in the meantime.

A single replacement also writes `new_string` exactly as sent. The sequences `$&`, `` $` ``, `$'` and `$$` were treated as replacement patterns and expanded. Edits with `replace_all` were not affected.
