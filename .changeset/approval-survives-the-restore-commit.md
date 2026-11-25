---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-shared': patch
---

An approval survives the commit Apply itself puts on a draft (hx-approval-survives-the-update-apply-makes).

Before it merges, Apply makes sure a change request carries no `roles.yaml` change: when the draft's copy differs from the target's, it commits the target's copy onto the draft. A draft cut before the target's `roles.yaml` last changed always differs, so every first Apply of such a draft moved its head. An approval is pinned to the head, so the approvals given seconds before went out of date and Apply answered `need to re-approve <file> after the latest push`, about files nobody had changed. The second Apply went through, because the copies then matched.

The restore commit now carries the approvals across it the way an update from the target does: every file whose bytes are the same before and after keeps its approval, by git's own diff between the two heads. A file the head move did change still loses its approval.

A carry that fails is no longer only logged. It is remembered and tried again by the next read of the request, for the restore and for an update from the target alike. Until it succeeds:

- Apply answers that the server could not yet carry the approvals already given over to the updated draft, so nothing was applied, and that applying again carries over the approvals of files the update left alone. The gate's own reasons follow (also as `gateReasons`), since a file the update changed still needs approving. It never says that no file needs approving.
- An update from the target answers its detail with `approvalCarryNotice`, a sentence the request dialog shows: the approvals of files the update left alone are carried over the next time the request is opened, and a file the update changed needs approving again.

What is owed is held in memory. A restart before the retry forgets it, and those approvals then need giving again.

Nothing an agent calls changes: no tool, argument or tool answer is different, so the agent guide is not edited.
