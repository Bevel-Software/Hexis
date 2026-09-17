---
'@bevel-software/platform-core-backend': minor
---

`file_stat` explains access. With the new optional `access: true` input, the response carries an `access` block; without it the response is unchanged.

`access.self` gives the caller's read, write, download and owner verdicts. Each one says what decided it: the folder whose rules granted or denied it, or the file's own frontmatter, with `inherited: true` when that is an ancestor folder. It also says which principal matched (the person, a group, a role, a plugin principal or `everyone`). A verdict no rule decided (nothing grants it, the admin rescue on access files, or a machine-owned file) has a null source. The verdicts come from a new resolver method, `explainAccess`, which shares the same decision walk as `canRead`, `canWrite`, `canDownload` and `canOwner` (their check is that walk's `allowed`), so an explanation cannot disagree with an operation.

`access.roster` lists the principals per verb as the Manage access dialog lists them: groups, roles, plugin principals and directly granted people, each with where its grant is written. It is only returned when the caller can write the path's access rules, the same gate the dialog's grant route applies. Anyone else gets `roster: null` and a one-line `rosterReason`. The dialog's route and the tool now build this view from one shared function.
