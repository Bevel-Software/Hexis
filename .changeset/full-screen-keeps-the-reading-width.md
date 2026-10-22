---
'@bevel-software/platform-core-frontend': patch
---

A Markdown or text file in full screen keeps the width it had on the page, so its lines wrap where they did and a reader deep in a long page comes back to the same line on entering and on leaving. The full-screen card had been 80px wider than the page's, which rewrapped the text and moved the reader several sections away. Opened straight from a `?fullscreen=1` link, with no page to match, the text takes the reading column's content width.
