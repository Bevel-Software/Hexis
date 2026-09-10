---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

Skills & Tools: a person's own space is called "Personal plugin" everywhere, one name for everyone. A personal `access.md` now states its privacy in both blocks: the frontmatter, like the body, reads `deny everyone` followed by the owner — no more empty `read: []` — and spaces seeded earlier get the same statement on the next start. Every plugin whose `access.md` frontmatter has that shape (`deny everyone` and only named people) shows a "Private" mark on its row; the server reports it as `isPrivate` on each plugin.
