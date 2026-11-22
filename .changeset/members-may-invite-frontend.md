---
'@bevel-software/platform-core-frontend': minor
---

The Invite button and the Invite people command (⇧I) open the Invite dialog for everyone signed in; on deployments with password sign-in and no single sign-on, Manage access's Invite action on a row with no account does too. The ask-an-admin popover is gone. The dialog offers the Role picker only to an admin, sends nothing until the admin verdict is in, has no starting-password field, and sends each address to `POST /api/invitations` (`sendInvitation`, exported from the auth module). A generated password is shown on its row in the result view with a Copy button, never in the message to forward, and is gone after Done or "Invite more people". A password the deployment delivered to the person directly (email, the companion) is not shown: the row says how it was sent.
