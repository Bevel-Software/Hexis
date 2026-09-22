---
'@bevel-software/platform-core-backend': patch
---

A symbolic link into the repository's internal git folder is refused with the sanitized 403 however the path to it is spelled. The rule's resolved half — the one that follows links — ran only after the path normaliser, and the normaliser refuses a `.` or `..` segment, a backslash and an absolute path with a message that quotes the caller's path back, so `knowledge-base/Notes/../gitlink/config` and its dot-segment, backslash, climb-out and absolute forms were answered by that instead. The check now reads the caller's own spelling every way it could land — backslash as a separator, an absolute path as itself, a leading climb both kept and dropped — before anything may rewrite or refuse it, on the agent tools, the workspace service, the review diff service and the agent filesystems.
