---
'@bevel-software/platform-shared': minor
---

`InvitationRequest` and `InvitationResult`: the request and answer of `POST /api/invitations`. A created answer says in `singleSignOn` whether the deployment's single sign-on lets the address in, and in `passwordDeliveredBy` which channels carried the generated password to the person, in which case it holds no `startingPassword`.
