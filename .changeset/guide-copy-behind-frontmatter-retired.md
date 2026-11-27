---
'@bevel-software/platform-core-backend': patch
---

A root guide copy written by the releases of 2026-09-09 to 2026-10-06, whose managed header sits on line 14 below the copy's own `read: everyone` frontmatter, is now recognised as the platform's: the next start removes it, and `read_file` of the guide's name no longer serves it ahead of the guide. The header is looked for in the first lines of the body after a leading frontmatter block, so a quotation further down an organisation's own file still leaves that file alone.
