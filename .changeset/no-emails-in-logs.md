---
'@bevel-software/platform-core-backend': patch
---

Log lines no longer carry email addresses. The notice logged when a queued save fails for good is now keyed by the user's id, a failed approval check no longer names the viewer, and the two lines that announce a newly created system account print its id only.
