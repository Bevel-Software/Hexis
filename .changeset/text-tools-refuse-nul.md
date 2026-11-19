---
"@bevel-software/platform-core-backend": patch
---

`write_file`, `write_files` and `edit_file` now refuse text that holds a NUL character (U+0000), before anything is written. Such a write used to land and made the file binary from then on: `read_file` answered with a notice instead of the content, and the text tools refused every attempt to repair it, so the page had to be restored from history by hand.

The refusal is a 400 with `kind: 'nul_in_text'`, and names the argument that holds the character (`content` or `new_string`) and its offset. In `write_files` it is that path's outcome only, and the rest of the batch lands. The character is refused, not stripped, so a tool never writes text the caller did not send.

The upload tools, `copy_file`, `move_file` and `unzip` carry bytes as they are and are unchanged.
