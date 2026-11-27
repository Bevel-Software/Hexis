---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

Removing a skill from a plugin's plugin.json by hand no longer leaves the plugin's members reading it unseen. The link index now finds grants of a plugin's `plugin/<name>/read` and `plugin/<name>/write` tokens that open released skills the manifest does not link. When someone who may write the plugin opens its page, the automatic repair revokes those tokens from each such folder whose access file they may write, as Unlink does, unless the same grant also opens a skill the manifest still links (the repair report's new `revoked` lists the folders). A grant that stays is named, to whoever may read the skill, on the skill page's "In plugins" and on the plugin page, with the access.md it is written in, and who can remove it (`GET /api/skills` carries it as `leftoverGrants`).
