---
'@bevel-software/platform-core-frontend': minor
---

The Invite button, the Invite people command (⇧I) and Manage access's Invite action on a row with no account open the Invite dialog for everyone signed in; the ask-an-admin popover is gone. The dialog offers the Role picker only to an admin, has no starting-password field, and sends each address to `POST /api/invitations` (`sendInvitation`, exported from the auth module). A generated password is shown on its row in the result view with a Copy button, never in the message to forward, and is gone after Done or "Invite more people".
