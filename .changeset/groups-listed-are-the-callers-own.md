---
'@bevel-software/platform-core-backend': minor
---

The groups a person is shown are their own, unless they are an admin. The Library's Groups tab used to list every group in the active group source to every signed-in person, and the share dialog's picker offered every group as a grantee; on a deployment that gives each client, author or customer a group of their own, that list was the client list. An admin still sees and may grant to every group, since they manage them. Anyone else sees `Everyone` and the groups they are a member of, is offered only those in the share dialog, and a grant naming any other group is refused with the same answer as a group that does not exist. What each listed group can use is unchanged, still cut to what the caller can read. Membership is direct: holding a role that lists a group does not make a person a member of it.
