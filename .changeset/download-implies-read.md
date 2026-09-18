---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': patch
---

A `download` grant now confers `read`, the way a `write` grant does (`write` is the key an access.md carries; the dialog shows it as "Can edit"). Granting someone Download without Read used to be a dead combination: the raw-file route checks read before it checks download, so the person could neither open the file nor save it — and the Manage access dialog let anyone create that pairing. The verbs now nest as `owner` over `write` and `download`, and `write` and `download` each over `read`.

The implication is grant-only, exactly like the existing one. A `deny download` says nothing about read: someone who reads a folder through a parent grant and is denied download on a file inside it can still open that file, and still cannot save it. Every shape of grant folds the same way — a direct `Name <email>` entry, a role, a group, a plugin token, a rule inherited from an ancestor folder, or a node's own frontmatter.

The Manage access dialog shows Read as checked and greyed whenever Download is checked, on a new grant and on an existing row, and its verb summary reads "Can read, Can download". Choosing Download alone writes one `download:` line rather than a redundant `read:` beside it, since the one line already carries both.

Existing `download:`-only rules become live read grants on upgrade. That is the intent — those rules previously granted nothing at all.
