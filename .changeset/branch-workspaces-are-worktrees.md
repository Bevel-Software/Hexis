---
'@bevel-software/platform-core-backend': minor
---

Branch workspaces share one repository. Every branch of a knowledge base used to get a full clone on the server, the whole history copied once per branch: 142 branches took 60 GB on Bevel's own knowledge base, and every clone fetched on its own. Now a deployment holds ONE repository per knowledge base, with the objects and the remote-tracking refs, and every branch workspace is a `git worktree` of it, at the same path as before (`<workspaces>/<branch id>/<kb folder>`), so everything that reads or writes files by path is unchanged. Opening a branch copies no history, a fetch is done once for every workspace, and deleting a workspace removes and prunes its worktree and nothing else.

The repository lives under the backups root (`<backups>/.kb-repository/<kb folder>.git`), which every shipped compose file already mounts as a persistent volume: no compose change is needed. A deployment whose own compose file does not persist the backups root must, or a redeploy loses the repository while keeping the worktrees, which are then recreated from the remote (commits that were never pushed are lost with it). On hexis-cloud every tenant has its own backups root, so one repository per tenant.

Upgrading converts the full clones an earlier release left at boot, one at a time: a clone's branch tip — commits the remote lacks included — is imported into the repository first, and only then does the worktree replace the clone. A clone that cannot be converted (uncommitted changes in it, objects that cannot be read) keeps working as a clone, is logged by branch, and is tried again at the next boot. No branch loses a commit.

When the knowledge base's repository address changes to another repository, the repository and all its worktrees are set aside together, into the same `replaced-working-copies` folder clones went to; nothing is deleted.

Git operations on two different worktrees run side by side. A fetch, a worktree add, remove or prune, and every write to the shared git config take one repository-level reservation, which waits for the worktree operations in flight. A push now stamps its upstream after the push instead of with `-u`, so it does not hold that reservation over the network.

Rolling back to an earlier release needs the workspaces volume cleared first: that release does not recognise a worktree and would treat each as a clone. Unpushed commits stay in the repository folder under the backups root, which a rollback leaves in place.
