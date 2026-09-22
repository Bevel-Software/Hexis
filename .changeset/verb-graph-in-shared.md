---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

The access verbs and the dependency graph between them move to the shared package, and both the resolver and the Manage access sheet fold verbs through it.

`platform-shared` now exports the verbs (`KNOWN_VERBS`, `Verb`), the graph (`VERB_REQUIRES`: owner presupposes write and download, write and download presuppose read), the two lists derived from it (`sourceVerbsFor`, which grants confer a verb; `requiredVerbsFor`, which denials strip it), the broadest-first application order, and three whole-set folds: `effectiveVerbs` (what a set of grants amounts to), `conferredByOthers` (a verb another tick already implies) and `minimalGrantVerbs` (the fewest lines that produce a set).

The backend grammar re-exports them, so nothing on the server changes its imports. The Manage access sheet drops its own copies of the same rules (the display fold for the new-grant checklist, the minimal grant list, the apply order, the row fold that added read under download, and the "checked because implied" rule for the checklist) and reads the shared ones. One table, one behaviour, on both sides.
