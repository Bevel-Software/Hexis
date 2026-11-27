---
'@bevel-software/platform-core-backend': patch
---

When the read of a commit's files fails right after the commit lands, the file-change reactors are still told of it, from the listing taken before it. That listing now names each file of a new folder, not the folder, and both ends of a rename, for the one-file commit (`commit_change`) and for a batch without a scope. A scoped batch already named them. A single-file save names its one file, as before. A commit whose files are read as usual is announced as before. The one-file commit lists the working tree once more before it stages.
