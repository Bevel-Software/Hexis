---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-shared': minor
---

`merge_branch` waits for the source branch's pending commits. Writes are committed asynchronously, so a merge issued right after a write used to find nothing new on the remote and answer `merged` at the target's unchanged tip. It now waits up to 20 seconds, holding no lock, for the source's queued commits to land, then merges. Two new outcomes: `pending-commits` (`branch`, `pending`, and `needsAttention` with the worker's message when a queued commit failed; nothing merged; retry shortly while writes are committing, or once a person has resolved the failed commit when `needsAttention` is present) and `nothing-to-merge` (`sha` is the target's tip). `merged` now means a merge commit was made. The app's change-request apply is unchanged.
