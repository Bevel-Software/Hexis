---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': patch
---

Restricting someone below what a parent folder grants no longer makes them disappear from the Manage access dialog, and no longer takes a detour through a confirmation.

Every row now carries the same two controls, whether the access was granted here or inherited: one verb menu — Owner, Can edit, Can read, Can download, then Deny — and the same Remove beside it. An inherited row used to show read-only text there, which left "give this person less than the parent gives them" something the sheet could describe but not do.

A menu item is a whole SET, not a checkbox. Picking one states the verbs the principal should end up with here, and the dialog writes the difference in the background: verb-scoped `deny` entries at this target for the verbs the set drops that a parent still grants, a plain revoke for the ones granted only here (so no dead `deny` line is left to reason about later), and grants for anything the set adds that nothing confers. Picking a set at or above the parent's lifts the local denials the new set no longer needs. Deny is the whole-principal block: every verb, read included, denied here — and the row stays, reading "Denied here", with the same menu ready to lift it.

The bug underneath was in the payload. `GET /api/workspace/:id/access` reported only grants, so a principal whose one entry on a folder was a denial had no local grant, fell into the collapsed parent section, and read as removed — and a principal denied *every* verb holds nothing, so no eligible list carried them and the row vanished outright. The response now also carries `denials` (per principal, per verb, with the same `direct` / `ancestor` source split as `sources`) and `deniedHere` (the principals this target restricts). The dialog decides its sections by local ENTRY, grant or denial, and each menu item says where its verb stands: "from Sales", or "restricted here".

Remove is unchanged: on a direct row it revokes here, and on an inherited row it still asks whether to remove at the parent or restrict just this item — two genuinely different acts, so it still asks which. The folders it offers to remove at are the ones that GRANT: a parent that merely restricts someone has no access to hand back, and removing them there would lift that restriction in answer to a click asking for less.
