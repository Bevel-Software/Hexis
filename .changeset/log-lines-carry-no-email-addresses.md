---
'@bevel-software/platform-core-backend': patch
---

Log lines carry no email addresses. The notice logged when a queued save fails for good, a failed approval check in the review workflow, a contended or refused lock, and the lines announcing a newly created system account all named people by email; they name them by opaque id now, as the data-processing terms state container logs do.
