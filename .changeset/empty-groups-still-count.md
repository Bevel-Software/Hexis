---
'@bevel-software/platform-shared': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

Two group fixes. A group you are in now appears in the sidebar's
"Included in your MCP" list even while it is empty: membership comes from
the group summaries, only the counts come from the catalog. And
non-admins can actually create groups again: the provisioning endpoint's
inline commit now pushes with a system authorization, because the push
gate read access at origin, where the new folder does not exist and the
root answers "write: Admin" — refusing the very carve-through the
endpoint exists to provide.
