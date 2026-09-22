---
'@bevel-software/platform-core-frontend': patch
---

The per-person permission menu on the Manage access sheet treats download and the access tier as two separate choices, so changing one no longer takes the other away.

Each item in a grantee row's menu used to apply a fixed whole set: "Can edit" meant edit and no download, "Can download" meant download and no edit. Giving an editor download therefore revoked their edit, and giving a downloader edit revoked their download, in the access file and with no prompt. The menu had always drawn download below a separator as its own axis; the clicks now behave that way.

Owner, Can edit and Can read are one exclusive tier: clicking a tier the row does not hold moves it there and leaves download as it was; clicking the tier it already holds steps it down one (Owner to Can edit, Can edit to Can read). Can read at the top of a row has nothing below it and renders disabled, since taking read away is what Remove and Deny are for. Can download toggles on its own and leaves the tier alone; under Owner it is conferred rather than chosen, so it renders checked and disabled, and a person stepped down from Owner does not keep it, because they never held it independently.

The new-grant checklist, Deny and Remove are unchanged.
