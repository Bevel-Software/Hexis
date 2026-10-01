---
'@bevel-software/platform-core-backend': minor
---

`open_change_request` answers with a summary, and sends the patches only when asked.

Opening a change request for 27 files answered about 445,000 characters: the tool returned `{ changeRequest }`, the full detail the app's dialog reads, every file's patch included. That overflows an agent's tool-result limit, so the one field it needed — the link to hand the user — could not be read at all without saving the result and parsing it with a script.

The tool now answers a purpose-made summary, and it is no longer wrapped in `changeRequest`:

```
url, urlNote?, number, title, state, sourceBranch, targetBranch,
approvals, mergeBlockedReasons, files, totalFiles
```

`url` is the first field on purpose — it is the one thing the agent must hand the user, so it survives a truncation of anything after it. `files` lists the changed paths with their kind of change (`added` / `changed` / `deleted` / `moved`, a `moved` one with its `previousPath`), cut to 25 with `totalFiles` naming the full count. There is no patch and no file content. `approvals` says who must approve each listed path (`roles`, `users` by display name, `approved`, `inMergeGate`, and `approversUnknown` when the access tree could not be resolved) — the dialog's own per-file entry without the emails, timestamps and viewer hints an agent cannot act on. `mergeBlockedReasons` is the detail's list verbatim, and it is never cut: it names every missing approval, including on paths the file list cut.

For the reported case — 27 new files of 15 KB each — the answer is 8,918 characters where the detail is 416,498.

An agent that wants more asks by name: `include: ["patches"]` gives each listed file its unified diff, `include: ["all-paths"]` lists every changed path instead of the first 25, and the two may be combined. The tool's description says what the default answer holds and how to ask for more.

Nothing below the tool changed. `IWorkflowService.openChangeRequest` still returns the full `ChangeRequestDetail`, the app's dialog and its routes serve exactly what they served, and the shaping is a pure function (`summarizeChangeRequest`) beside the tool. The `change-request-conflicts` error is unchanged.

For integrators: a caller that read `changeRequest.url` or `changeRequest.number` off this tool reads `url` and `number` at the top level now, and one that read `changeRequest.files[].patch` or `.body` asks for `include: ["patches"]` (nothing in this repository read either).
