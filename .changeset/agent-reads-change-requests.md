---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
---

An agent reads change requests the way the GitHub pull request API offers them.

Five read tools, named and shaped after their GitHub counterparts: `list_change_requests` (filtered by `state`, `head`, `base` and `author`), `get_change_request`, `list_change_request_files`, `list_change_request_reviews` and `list_change_request_comments`. Field names are GitHub's where GitHub has a counterpart — `number`, `state`, `title`, `body`, `user`, `head`, `base`, `created_at`, `updated_at`, `merged`, `mergeable`, `html_url` — so a merged request reads `state: closed` with `merged: true`. What Hexis has beyond GitHub rides under its own names: each file says who must approve it and who has, and a request says what is blocking its merge and whether the caller may approve or apply it.

`body` is what the author wrote. Hexis appends a generated `## Affected owners` block to a change-request body, one line per changed path; the read tools cut it off exactly where the app's own change-request dialog has always cut it, so a person and an agent see the same text and a reader of one folder is never handed the name of a file in another. Who must approve each file is read from `list_change_request_files`, where it is access-filtered per file.

Every tool answers only what the caller may read, resolved against the target branch's access tree exactly as the app's own file reads are. A request whose files the caller may read only in part lists the readable ones and says how many are withheld without naming them; the same goes for comments, reviews and merge blockers. A renamed file is judged on both of its names, since the diff of a rename shows what was at the old one. A request the caller may not see at all answers as not found, word for word what a number that was never issued answers. No tool returns a patch unless asked for one, every list is paged (30 by default, 100 at most), and none of them changes anything.
