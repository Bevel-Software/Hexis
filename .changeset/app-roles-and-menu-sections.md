---
"@bevel-software/platform-core-backend": minor
"@bevel-software/platform-core-frontend": minor
---

An app built on core can define roles of its own and give the profile menu sections of its own.

`ServerExtensions.appRoles` takes the app's roles (`AppRole`: a display name and the one-line description admins read). App roles lists every role the deployment defines, core's Admin and the app's, whether anyone holds it or not; one nobody holds yet shows with no members. The first person or group an admin gives such a role writes its entry into `roles.yaml`. An app role is refused conversion to a group. The server refuses to start, saying why, when an app role's name is one roles.yaml cannot hold (a reserved name, a `role/`, `group/` or `plugin/` prefix, a name that does not read back as written) or one core or another app role already has. What a role unlocks stays the app's own check.

`AdminMenuItem.section` also takes an `AdminMenuSection` (`id`, `label`, optional `order`): rows naming the same section are drawn under its label between the default rows and "Admin only", shown to whomever each row's `isShown` names, admin or not. A section none of whose rows is offered has no heading. The command palette offers those rows it can represent (a plain-text label and a path or action, not a dialog) to the same people. `useMenuSections` returns them as `appSections`.
