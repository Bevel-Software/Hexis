---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

The Skills root in the Skills & Tools sidebar is a collapsible folder now, exactly like Knowledge and Data in the Knowledge explorer, and sits right under All plugins. It opens with its scopes collapsed, takes drops, offers the create buttons and the folder menu, and cannot be renamed, deleted or dragged.

A shared skill that a plugin links but whose folder no longer grants the plugin's members is now reported where a manager will see it: the plugin's count in the sidebar and on the All plugins index turns orange, the plugin page opens with an orange banner naming how many links to repair, and the skill's card and its "Shared via plugins" section carry the same orange. Amber stays for a tool you have not set up for yourself; orange means other people are locked out right now. The count is the server's, so a manager whom the missing grant locks out of the skill still sees it.

Two smaller things: a person who may read a skill deep inside a folder they cannot otherwise open now finds it in the file tree, with the folders above it shown as the way there; and linking a skill into a plugin says "Linking…" while the commit runs instead of looking frozen.
