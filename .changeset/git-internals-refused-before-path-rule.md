---
'@bevel-software/platform-core-backend': patch
---

A path naming the repository's internal git folder is refused with the sanitized 403 whatever else is wrong with how it is spelled. The path normaliser refuses a `.` or `..` segment, a backslash and an absolute path with a message that quotes the caller's path back and names a corrected one, and for five families of spelling — parent-climb, dot-segment, backslash, climb-out, absolute — that answer reached a `.git` path first, so the agent tools returned a 400 naming the git path instead of the one sanitized refusal. Nothing under the folder was reachable either way; only the message was wrong. The git rule now reads the caller's raw spelling before normalisation, at every call site: the agent tools, the workspace service's one resolution point, the review diff pair and the agent filesystems.
