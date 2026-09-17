---
'@bevel-software/platform-core-backend': minor
---

Admins always keep write access at the repository root, so a root `access.md` can no longer lock the deployment out of its own knowledge base. A root rule that denies or drops Admin's write is ignored, and the share dialog refuses to remove it — for the Admin role and for a person who is an admin — saying why. A subfolder can still exclude Admin, and there an admin is refused like anyone else. The access dialog and the "Eligible: …" line in a write refusal now name only who would really be allowed at that path.

Two consequences worth knowing. Admins now write in every subfolder that does not exclude them, so they become eligible change-request reviewers there. And the deployment owner (`ADMIN_EMAIL`) now writes ordinary content, where before they could only edit `roles.yaml` and `access.md`.
