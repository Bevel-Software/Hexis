---
"@bevel-software/platform-shared": patch
"@bevel-software/platform-core-backend": patch
"@bevel-software/platform-core-frontend": patch
---

Moving a folder into its own subfolder is refused in words: `move_file`'s dry run answers `allowed: false` with the reason, the move answers 400 with the same sentence, and the app's rename and drag do too, instead of a raw `EINVAL` naming a server path. Nothing moves. The app's rename or drag of something that is no longer there answers that it is missing (404), and makes no folder on the way. The sidebar notice wraps a long path, so the sentence and its dismiss button stay in view.
