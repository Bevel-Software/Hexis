---
'@bevel-software/platform-core-backend': patch
---

`edit_file` now looks for `old_string` in the file as it is when the write lands. The file is read, judged, the replacement computed and the result written with the file's lock held, so nothing can change the file in between. Before, the tool read the file first and took the lock only for the write: two callers replacing the same text were both told their edit had landed, and the later write silently overwrote the earlier one. Now whichever of them gets the file's lock first has its edit land and stay, whatever order the calls were made in, and the other is answered `old_string not found in the file.` An edit to text that is still there keeps whatever else was changed in the meantime.

A single replacement also writes `new_string` exactly as sent. The sequences `$&`, `` $` ``, `$'` and `$$` were treated as replacement patterns and expanded. Edits with `replace_all` were not affected.
