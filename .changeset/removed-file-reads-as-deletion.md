---
'@bevel-software/platform-core-frontend': patch
---

A change request that removes a file shows that file as its current copy with every line deleted, as the file list and the diff boxes already did. The pane used to read the file on the request's branch, where it no longer exists, and report the 404 as "This file couldn't be read right now (HTTP 404). Try again." — with nothing to show and a retry that could never succeed.
