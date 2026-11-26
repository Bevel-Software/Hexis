---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

A write refused because the caller cannot read the path now names the path written, whether or not something is there. Before, it named the path when something was there and its folder when nothing was, which told the caller whether a file they may not read exists. An archive extraction or upload relays this refusal for each entry, so one call could test thousands of guessed names. The app's message for this refusal names that path too ("You can't add or change … because you don't have read access to it"); the top level keeps its sentence.
