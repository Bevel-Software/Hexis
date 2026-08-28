---
'@bevel-software/platform-core-backend': patch
---

The shell tool's timeout and abort now kill the whole process tree the command started, not just the `sh` in front of it — the orphans that accumulated as unreaped zombies until a host could no longer fork. Workspace clones are stamped with `gc.autoDetach=false`, so git's automatic gc runs inside the command that triggered it instead of detaching into a background process nothing reaps — the source of the zombie `git` processes seen piling up under a platform container. The server image now runs under `tini`, so a deployment built from the Dockerfile alone gets a reaper without depending on `init: true` in its compose file.
