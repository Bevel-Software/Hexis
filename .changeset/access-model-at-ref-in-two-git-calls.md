---
'@bevel-software/platform-core-backend': patch
---

Change-request listings on a knowledge base with many open requests no longer take minutes. The access model at a commit, which the "for me" listing builds for every open request's two refs, used to read its files one `git show` at a time: a few dozen access files times a hundred refs was thousands of git processes per listing, each forking the server, with the file tree and every other request waiting behind them. A build is now two git calls, one `ls-tree` and one `cat-file --batch` for every file the model reads; the cache of built models holds 512 commits instead of 64, enough for a listing's refs so they are built once; and a commit with no roles.yaml is remembered rather than read again on every call. Paths that git would quote (a non-ASCII character in a folder name) are listed as they are, so their access files are read too.
