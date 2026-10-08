---
'@bevel-software/platform-shared': patch
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

An agent deletes a nested `access.md` the way a person does in the app, and nobody deletes the root's.

`delete_file` refused every `access.md` at any depth as a platform file, while the app's delete route removed any of them — the root's included, which left the whole repository ungoverned. Now both surfaces agree: a nested `access.md` is deleted by whoever may write it (anyone else gets the ordinary write refusal), and its folder then follows its parent's rules; the repository root's `access.md` and `roles.yaml` are refused everywhere with "<name> is the repository's own file and cannot be deleted." — by `delete_file`, by `DELETE /workspace/:id/file` (409), and by the explorer, whose Delete is drawn disabled with that sentence. `file_stat` reports a nested `access.md` as `managed: true` and `deletable` by the caller's write access. `delete_folder` and `.bevelignore` are unchanged. The shared file rules in the agent guide state the delete rule.
