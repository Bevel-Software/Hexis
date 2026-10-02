---
'@bevel-software/platform-core-backend': minor
---

`list_skills` and `get_skill` now take an optional `branch`, so an agent can try a skill on the draft it wrote it on instead of waiting for the change request to merge. Without a `branch` both answer exactly as before, from the released (default-branch) catalog.

With a `branch` they read the skills as that draft has them: a skill that exists only there is listed and loads, one changed there loads with its changed content, one deleted there is absent. Access is judged in that branch's own clone, with that branch's access rules — a skill the caller may not read there is absent from the listing and answers like a skill that does not exist, so a draft nobody may see does not announce itself. A branch the platform has never heard of answers the file tools' 404, naming the branch.

Anything the default branch does not already serve is marked: each listed skill that differs from it carries `unmerged: true` and the branch name, and a loaded skill's body begins with one line saying it comes from that unmerged branch and is not approved (a bundled file carries the two fields beside its content rather than a sentence inside a script). A skill the draft shares byte-for-byte with the released one is the released one, so it carries no mark and no line. `get_skill` refuses `branch` together with `version`, and the `allowed-tools` warnings are computed from the branch's version of the skill.

Skills offered as MCP prompts are unchanged: they come from the default branch only. A branch read is never cached, so a skill written a moment ago is listed a moment later.
