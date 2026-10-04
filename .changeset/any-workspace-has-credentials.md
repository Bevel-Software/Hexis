---
'@bevel-software/platform-core-backend': patch
---

Change requests are no longer reported as `unknown branch` when their branch is on the remote.

Listing change requests, reading one by number and listing branches are not about one draft, so they run in whichever working copy is already on disk. That working copy is one the process may never have opened, and a working copy is given the deployment's git credentials when its branch is opened. On a deployment whose oldest working copy predated that, every such operation ran in a clone that could not authenticate: its fetch failed with `could not read Username`, the failure was swallowed, and each open change request whose branch that clone had never seen logged `changedPathsForPr failed … unknown branch` on every list, showed no changed files, and dropped out of the reviewers' lists. One deployment logged that for thirty-four open requests, all of whose branches were on the remote. Opening the old branch once in the app was the only cure.

The working copy is now given the deployment's credential helper before it is handed to a repo-global operation, the same stamp opening its branch applies, written once per process and leaving an operator's own helpers alone.

A fetch of a change request's branches that fails for any reason other than the branch being gone from the remote is now logged, naming the working copy and the reason, at most once a minute per working copy. The fetch stays best-effort; what changes is that the log says the fetch was refused rather than naming a branch as unknown with nothing before it.
