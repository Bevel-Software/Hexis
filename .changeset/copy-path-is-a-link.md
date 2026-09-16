---
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-core-backend': patch
---

Copy path, on a sidebar row and now also in the page's Share menu, copies the root-anchored form `/knowledge-base/…`. Pasted into a Markdown link, it opens the file from any folder. Before, the copied path had no leading slash, so Markdown resolved it against the linking file's folder and the page said File not found. Pasting a bare workspace path or an `http(s)` URL into the editor now inserts a Markdown link, labelled with the file name without its extension or with the URL's host and path. If text is selected, the selection becomes the label. Anything else pastes as before. Every agent tool that takes a path accepts a leading slash as the same workspace path, and its description says so. Paths outside the repository are still refused.
