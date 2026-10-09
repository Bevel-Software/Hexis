---
'@bevel-software/platform-core-frontend': patch
---

A page someone else has open for editing says who, in plain words: "Dana is editing this page. You can edit it when they finish." The Edit button's hover text says the same ("Dana is editing this page"), and "Getting the latest version…" replaces "Acquiring lock and fetching latest content…" while editing starts. A save refused because your editing session had already ended now reads "Your editing session ended before this save. Check the page and edit it again if anything is missing." instead of the server's "Cannot release lock … not held by you".
