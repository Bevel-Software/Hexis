---
'@bevel-software/platform-core-backend': patch
---

The history read-gate closes its side doors. A path without the repository prefix is refused instead of passing ungated — the git layer reads `GTM/x.md` and `knowledge-base/GTM/x.md` as the same object, so the exemption was a bypass by spelling. A directory pathspec is refused at the git layer (`history is served per file`): `show <ref>:<dir>` walks children the per-file gate never checked. `compare-file` authorizes against both branches actually being served, not just the caller-chosen workspace. Deleting a change request now demands a provably fresh `origin/<base>` before reading `roles.yaml` there — authorization never runs against refs of unknown age — and a fresh clone counts as a successful fetch for strict branch listings.
