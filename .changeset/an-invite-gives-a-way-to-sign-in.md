---
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-core-backend': minor
---

An invite gives people a way to sign in, with or without single sign-on. The Invite dialog asks the deployment how people sign in before it sends: without single sign-on it requires a starting password, given to every account the send creates and to an existing, switched-on account that has none (an account with its own password keeps it, and the server checks that as it writes); with single sign-on a password is an option. Each result row says how that person signs in, and the message to forward says how to sign in here and never contains the password. Manage access says an address with no account can't sign in until invited, and gives admins an Invite action. User accounts' Add account form is replaced by an "Invite new users" row that opens the same dialog. Everyone sees Invite in the top bar; someone who is not an admin is shown the admins, each with an Email button, read from the new `GET /api/access/admins` (names and emails only).
