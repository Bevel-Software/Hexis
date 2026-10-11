---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

The owner can never be switched off, and their account is deleted only where they can still sign in.

The owner is the address the deployment is configured with as its owner (`ADMIN_EMAIL`; on Hexis by Bevel cloud, whoever created the workspace), whether or not the server holds a password for them. The accounts API now refuses to switch an owner off on every deployment ("The owner can't be switched off."), and refuses to delete an owner's account unless they can sign back in with a password the server holds — password sign-in on and `ADMIN_PASSWORD` set ("The owner's account can't be deleted: they would have no way to sign in."). Where it is allowed, deletion behaves as before. Another admin can no longer set or reset an owner's password through the same API. Before this, a deployment without `ADMIN_PASSWORD` (the cloud) let any other admin lock its owner out with one click.

On User accounts, each owner's row is labelled "Owner" and offers no Switch off and no Set or Reset password; Delete account appears only where the server allows it. `GET /api/admin/accounts` reports `isOwner` and `ownerCanBeDeleted` for each account. The owner's wording is plain "Owner": "Password (owner)", "they can still sign in with the owner password set on the server, but will start fresh.", "The owner stays in roles and access rules.", and on App roles "Owner; cannot be removed here." — the note beside the owner's fixed Admin membership, and the sentence the server's refusal leads with.
