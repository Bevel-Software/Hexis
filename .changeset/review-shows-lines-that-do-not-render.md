---
'@bevel-software/platform-core-frontend': patch
---

A change request's review now shows every line the request adds or removes in a markdown file, including lines that do not render. An HTML comment in a changed passage appears as its source text inside the red or green change block, and a YAML comment added to or removed from the frontmatter appears as a marked source line under the frontmatter panel. Before, such a line left an empty change block (or an unmarked page) while the file could be approved. The same diff view serves the review panel and the file history, so they show these lines too. Comments in unchanged passages stay hidden, as on the page.
