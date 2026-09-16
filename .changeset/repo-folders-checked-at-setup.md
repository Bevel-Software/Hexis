---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-shared': patch
---

Setup shows the Knowledge, Skills and Plugins folder fields in the main "Knowledge, skills & tools" section instead of under Advanced, and Test connection now lists the repository's top-level folders: each field says whether its folder was found, will be created, or exists under a different spelling (`skills/` for `Skills`), with the listed names offered as suggestions. Warnings never block the save. The save that completes first-run setup applies the folder names straight away, so the knowledge base is initialized with them without a restart.
