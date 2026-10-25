## Drafts and change requests

An agent drafts, proposes and syncs; a person merges. No agent tool approves a
file, bypasses an approval or merges a change request (`merge_change_request`
no longer exists).

- **Start a draft** with `create_branch`: `name` is the new draft, by
  convention `<email-localpart>/<topic>`, and `branch` is the branch it forks
  from, usually `{{defaultBranch}}`:
  `create_branch({ body: { name: "ana/pricing-page", branch: "{{defaultBranch}}" } })`.
  It is shared at once, and the file tools then take the draft as `branch`.
- **Saving shares.** Every write is committed as the person and shared,
  moments after the call returns; there is no separate push. `branch_status`
  lists writes still landing. `share_current_branch` is only for sharing
  again after a refused push, and `commit_change` only for a file a tool left
  uncommitted (`unzip` does).
- **Propose** with `open_change_request`
  (`sourceBranch` = the draft, `targetBranch` = the protected branch, a
  `title`), then give the person the request's `url`. It first brings the
  latest target into the draft. The answer lists `approvals` (who must approve
  each file) and `mergeBlockedReasons`. Reviewing, approving and merging happen
  in the app; someone who may approve every file it changes may merge their own
  request there.
- **Edit** an open request with `update_change_request`: `description`
  replaces the text whole, `appendDescription` adds a paragraph. Allowed for its
  author and anyone who may merge it.
- **Know where a draft stands** with `branch_status`: ahead or behind, whether
  the shared draft moved (`behindRemote`), writes still landing, the protected
  branch it was forked from, and `changedPaths`, the files a request would
  carry. That list holds only files you may read; `withheldPaths` counts the
  others (changed or still landing), so above zero the list is not the whole
  request. Ask it before proposing.
- **Sync** a draft with `update_branch` on the draft, `from` = the request's
  target. It is allowed while the request is open. Without `from` it brings in
  the draft's own shared state, for when it moved while your workspace held
  commits (`behindRemote`). `merge_branch` (`source` = the target, `target` =
  the draft) does the same without conflict handling.
- **`merge_branch` into a protected branch** merges only what you could write
  there directly, never a change to `roles.yaml`, and refuses a draft whose
  open request targets that branch: ask the person to review it in the app.
- **Read history** with `list_file_changes` (a file's commits: who, when,
  subject), `read_file_at` (the file at a commit, given as the full sha, or on
  another branch) and `compare_file` (the diff of a commit, or between two
  branches). To put an earlier version back, read it with `read_file_at` and
  write it with `write_file`.

### Settling a conflict

When `update_branch` answers `conflicts`, it has left the draft exactly as it
was. For each conflicted path it carries the file at the merge base, on your
side (`ours`) and on theirs (`theirs`), and the working copy with git's
markers. A side is null when it has no file, or when `truncated` names it
(too large, or not text): then read `ours` with `read_file`, `theirs` with
`read_file_at` at `from` (the branch name), and the base with `read_file_at` at
the answer's `mergeBase`. A side that is not text cannot be read that way:
settle that file whole with `choose`. A conflicted file you may not read on one
of the branches is only counted (`withheldConflicts`): ask a person who can read
it to update the draft in the app.

Decide each file (keep both sides' information unless one is clearly stale;
`list_file_changes` says who changed what and why), then call `update_branch`
again with the same `from` and `resolutions`, one per conflicted path: `content`,
the resolved text, or `choose` (`ours`, `theirs`, `delete`). A resolution is a
write on your draft: you must be able to read the path (or the folder it lands
in). It merges, commits as you and shares. If sharing is refused, or the shared
draft moved meanwhile, the answer is the saved-locally error: the merge is on
your draft but not shared, and `branch_status` shows it ahead. Do not report it as shared; the next save
or `share_current_branch` carries it. You never have a half-done merge to
finish.

### When a draft goes away

- **After a merge** the draft is deleted on its own, unless another change
  request is still open from or into it. Start a new draft for the next change.
  A draft whose open request turns out to propose nothing (its changes are
  already on the target) is removed the same way when that request is closed,
  and so is the draft of a request deleted in the app.
- **`delete_branch`** removes a draft for everyone. Only its author
  (`<email-localpart>/…`, or your own `suggestions/…` bundle) or an Admin may.
  Preview with `dryRun: true`: it changes nothing and says whether the delete
  would go through, how many commits are not on `{{defaultBranch}}`, and the
  last commit. A draft holding such commits is refused unless you pass
  `discardUnmerged: true`, only when the person wants that work gone. An open
  request from or into it that proposes nothing is closed by the delete; one
  that still proposes something refuses it, with a link: its author can
  withdraw it, or an Admin can decline it, in the app. A request you cannot see
  is not named, even in a preview, so a delete can still be refused after a
  clean preview. Hand the person the `lastCommit` it answers, so the draft can
  be restored.
