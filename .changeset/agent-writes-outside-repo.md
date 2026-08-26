---
"@bevel-software/platform-core-backend": patch
---

An agent write that names a repo-relative path (`KnowledgeBase/Foo.md` instead of `knowledge-base/KnowledgeBase/Foo.md`) is refused with the corrected path, instead of landing beside the repository where nothing commits or pushes it. The workspace directory holds the clone as `knowledge-base/` and the agent filesystem is rooted one level above it, so such a write used to succeed silently: the tool reported "committed + pushed", git saw nothing, and the explorer re-rooted on the stray `KnowledgeBase/` folder and showed the whole clone under Knowledge. Every creating operation on the lock-aware filesystem, `save_file`, and each `unzip` entry now require the prefix; the path inputs of every content tool and the root listing name it; and a commit that finds the bytes beside the repository throws instead of reporting nothing to commit. Removing a stray is still allowed, so a file the old behaviour left there can be cleaned up.
