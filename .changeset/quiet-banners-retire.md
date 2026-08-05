---
'@bevel-software/platform-core-frontend': patch
---

Remove the protected-branch banner from the file viewer. The amber strip that
explained "you're reading the Target company state — start a draft to change
it" is gone, along with its component and tests.

It was pure narration: it never gated anything (write access is decided by
roles.yaml + access.md and enforced per-path at commit time), it repeated a
fact the branch switcher already shows in the header, and it sat above every
document on the two branches people read most — a permanent strip that costs
vertical space on every page and teaches readers to skip banners, so the ones
that DO mean something (`PullNeededBanner`, `AccessRestrictedBanner`) get
skipped too.

Nothing else changes: those two banners still render in the same slot, and the
`isProtectedBranch` / `protectedBranchDisplayName` helpers stay — the branch
switcher, comparison panel, and change-request dialogs are still their callers.
