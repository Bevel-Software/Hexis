---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
---

An agent reads change requests the way the GitHub pull request API offers them.

Five read tools, named and shaped after their GitHub counterparts: `list_change_requests` (filtered by `state`, `head`, `base` and `author`), `get_change_request`, `list_change_request_files`, `list_change_request_reviews` and `list_change_request_comments`. Field names are GitHub's where GitHub has a counterpart — `number`, `state`, `title`, `body`, `user`, `head`, `base`, `created_at`, `updated_at`, `merged`, `mergeable`, `html_url` — so a merged request reads `state: closed` with `merged: true`. What Hexis has beyond GitHub rides under its own names: each file says who must approve it and who has, and a request says what is blocking its merge and whether the caller may approve or apply it.

Every tool answers only what the caller may read, resolved against the target branch's access tree exactly as the app's own file reads are. A request whose files the caller may read only in part lists the readable ones and says how many are withheld without naming them; the same goes for comments, reviews and merge blockers. A request the caller may not see at all answers as not found, word for word what a number that was never issued answers. No tool returns a patch unless asked for one, every list is paged (30 by default, 100 at most), and none of them changes anything.
