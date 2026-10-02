---
'@bevel-software/platform-core-frontend': minor
---

A deployment can now add its own entries to a folder's right-click menu in the explorer, through `folderMenuItems` on the app registry. Each entry has an id, a label, an optional icon, a function that says which folders it belongs in, and an action. The entries it applies to are drawn at the foot of the folder's menu, behind a separator and in the order registered, and are reached with the keyboard like the explorer's own.

Both the function and the action are told the folder's path, the branch, whether the viewer may write there and whether the branch is protected. The action is handed the explorer's own means of creating a folder, creating a file, refreshing the tree, opening a path and showing an error, so whatever it creates travels the routes "New file" and "New folder" travel: the access rules, the platform-file rules and the protected-branch rules apply to it unchanged, and a refusal is shown where a refused "New folder" shows one. An entry that fails says so and the menu closes; an entry that throws while deciding whether it belongs is left out and logged, and the rest of the menu is unaffected.

Nothing is registered here, so a Hexis deployment's folder menu is unchanged — separator included, which is drawn only when there is something to separate.
