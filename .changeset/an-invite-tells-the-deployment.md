---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

An invite is one seam a distribution's own notification extends. When an invite creates a NEW account, core runs the account-invited listeners the deployment registered (`accountHooks.onAccountInvited`), hands them who was invited, by whom and whether a starting password was set, and answers the invite with `notified`: the channels that reached the person, as the listeners said. Core registers nobody, so a core deployment answers as before. The Invite dialog reads the answer: a row the deployment emailed says "Emailed", and when everyone invited was emailed the dialog offers the link and the password reminder but no message to forward. Whether an account is new is answered by the write that made it, never by a read before it. An account that was already there, a set or reset password, or a first single sign-on is not an invitation and tells nobody.
