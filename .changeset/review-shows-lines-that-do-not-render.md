---
'@bevel-software/platform-core-frontend': patch
---

A change request's review now shows the HTML comments and frontmatter YAML comments a request adds or removes in a markdown file. These lines do not render, so before, a request whose only change was one of them left an empty change block (or an unmarked page) while the file could be approved. An HTML comment in a changed passage now appears as its source text inside the red or green change block, and a YAML comment added to or removed from the frontmatter appears as a marked source line under the frontmatter panel. The same diff view serves the review panel and the file history, so they show these lines too. Comments in unchanged passages stay hidden, as on the page. Other markdown that renders nothing, such as an unused link reference definition, is still not shown.
