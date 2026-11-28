---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

Manage access: a file's (or subfolder's) sheet now lists a person or group that a folder above denies, under that folder's "People invited to" section, reading "Restricted in <folder>", with the folder named for each verb the deny takes. Before, someone denied by name in a parent while a role they belong to could edit had no row on the child at all, so the role's "Can edit" overstated who could edit. The access view carries them in a new `deniedAbove` list beside `deniedHere`. A parent's deny that a closer grant beats is not listed.
