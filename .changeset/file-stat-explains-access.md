---
'@bevel-software/platform-core-backend': minor
---

`file_stat` explains access. With the new optional `explainAccess: true` input, its `access` block keeps the read, write, download and owner verdicts it always has, and adds `why` and `roster`. Without the input the response is unchanged.

`access.why` says what decided each verdict: the folder whose rules granted or denied it, or the file's own frontmatter, with `inherited: true` when that is an ancestor folder. It also says which principal matched (the person, a group, a role, a plugin principal or `everyone`). Admin's write at the repository root, which no rule there can take away, is reported as `admin-floor`. A verdict no rule decided (nothing grants it, the admin rescue on access files, or a machine-owned file) has a null source. The reasons come from the same checks that decide every read, write and download, so an explanation cannot disagree with an operation.

`access.roster` lists the principals per verb as the Manage access dialog lists them: groups, roles, plugin principals and directly granted people, each with where its grant is written. It is only returned when the caller can change the path's access rules, the same check the dialog applies when access is granted. For a file that cannot carry rules of its own, such as an image, that means the rules of the folder it sits in. Anyone else gets `roster: null` and a one-line `rosterReason`.
