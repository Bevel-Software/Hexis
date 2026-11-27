---
'@bevel-software/platform-core-frontend': patch
---

A change request's review shows an HTML comment that is never closed.

A `<!--` with no `-->` after it has no end: it hides every line from there to the end of its HTML block, in the review as on the page, while an agent that reads the file is handed all of them. The reveal for changed passages (`KB_DIFF_CHANGE_REHYPE_PLUGINS`) turned comments into text after the HTML was parsed, and the parser makes no comment of one that never closes, so a change that added one showed an empty green block.

The changed-passage pipeline now looks at each HTML block before it is parsed and shows the whole block as its source text when it holds an open comment, marked as added or removed like any other line. Whether a comment is open is asked of `stripHtmlComments`, the rule that already decides what a comment withholds from agents. An unchanged passage is rendered as before.
