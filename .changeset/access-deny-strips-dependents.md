---
'@bevel-software/platform-core-backend': patch
---

A denial in an access file now takes down every permission that presupposes the denied one, at that scope and below. Owner presupposes edit and download; edit and download each presuppose read.

On core-staging a folder denied the Admin role read, edit and download, and the Manage access sheet still showed Admin as Owner there, because the repository root grants owner to Admin and resolving owner read only owner lines. The same gap let `canOwner` answer yes for a folder its holder could not open. Now a closer `deny write` strips owner, and a closer `deny read` strips edit, download and owner. Nobody owns what they may not edit, and nobody edits or saves what they may not open.

What did not change: a superset denial still says nothing about the verbs below it (`deny write` leaves a separate read grant standing), a grant confers only downwards, and within one file a grant of the verb or of one that confers it still beats a denial beside it.

The dependency graph is declared once, in the grammar beside the verbs (`VERB_REQUIRES`), and both folds are derived from it: which grants confer a verb, and which denials strip it. Adding a verb, or changing what one presupposes, is a change to that table alone. The share dialog's denial sources report only lines a file actually holds, so a denial a folder implies (owner off because edit is denied) shows as the edit restriction it is, never as an owner line nobody wrote.
