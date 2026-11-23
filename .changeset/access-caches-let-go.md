---
'@bevel-software/platform-core-backend': patch
---

The access caches no longer grow with uptime. A cached at-ref model reads its commit's listing from bytes, one string per path, so it keeps no view onto the listing; commits that share most of their paths share one base set of them, and a commit's tree index costs what it changed. Measured on a 20,000-path tree: about 13 KB held per cached commit (before: the 1.7 MB listing and a 20,000-entry set). The per-workspace memo of a file's own access entries keeps only `.md`, `.tool` and other access-frontmatter files, copies what it keeps into strings of its own, drops a workspace's memo once it is five minutes old at the next batch check or invalidation on any workspace (that workspace need not be asked again), and holds at most 32 workspaces and 200,000 entries, oldest dropped first. What the gates answer is unchanged.
