---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': patch
---

A plugin's name now comes from one place. Its identifier is the manifest's `name`; what people see it called is the manifest's `displayName`, and — when the file says nothing — that same `name`. The folder it lives in is no longer consulted for either.

It used to be. The manifest carried `displayName` only when it disagreed with the folder's spelling, the rename path deleted the field the moment it agreed again, and every reader fell back to the folder — so the API always answered with a display name while the file sometimes omitted it, and where a plugin happened to sit was a hidden input to what everyone saw. An agent tester created plugins each way and found the display name derived differently at each stop; the paths were never the problem, the rule was.

Every write path now persists the field. Creation — the New plugin dialog and the `create_plugin` tool, which have always been one endpoint — stores the name its creator typed, trimmed, whether or not it matches the identifier or the folder; both answer with `name` and `displayName` exactly as they were written. A display-name edit stores what was typed and never removes the field, and it never touches the identifier.

So that nothing renames itself on the upgrade, one startup step writes each existing plugin's folder spelling into its manifest — but only where the manifest lacks the field AND the folder is spelled differently from the identifier, which is precisely where the folder was the answer people saw. A manifest that already names itself is left alone, as is one whose folder already reads like its identifier.
