---
'@bevel-software/platform-core-backend': patch
---

Log lines no longer carry email addresses or names. The notice logged when a queued save fails for good is keyed by the user's id and its body names the queue row instead of the author's address; the commit author a queued save runs as has an opaque id, so a refused push logs no address through it; a failed approval check no longer names the viewer; the two lines that announce a newly created system account print its id only; and a contended or refused file lock names its holder by id, not by name.
