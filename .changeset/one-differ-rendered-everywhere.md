---
'@bevel-software/platform-core-frontend': patch
---

Change requests show markdown as rendered documents, and every diff surface
now computes through one engine.

The change-request dialog renders `.md` files through the same
frontmatter-aware `MarkdownDiffViewer` the review flow and version history
use: prose with red/green change blocks and a structured frontmatter panel,
instead of raw markdown source with strike-through marks. Non-markdown files
keep the marked-source view — that is the right presentation for yaml,
scripts and config.

Under it, the app's two independent line-LCS implementations became one:
the hardened engine (CRLF normalisation, common prefix/suffix trimming, a
cost guard that degrades to whole-block replace instead of hanging on huge
files) now lives in `workspace/utils/diff.ts`, and the change-requests
module adapts its output shape. The rendered-markdown viewer inherits the
CRLF fix — a file checked out on Windows no longer diffs as a full rewrite.
