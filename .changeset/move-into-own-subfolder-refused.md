---
"@bevel-software/platform-shared": patch
"@bevel-software/platform-core-backend": patch
"@bevel-software/platform-core-frontend": patch
---

Moving a folder into its own subfolder is refused in words: `move_file`'s dry run answers `allowed: false` with the reason, the move answers 400 with the same sentence, and the app's rename and drag do too, instead of a raw `EINVAL` naming a server path. Nothing moves.
