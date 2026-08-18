---
'@bevel-software/platform-core-backend': patch
---

Seed the KB template's root `access.md` in the current two-block format.

The shipped template still used the legacy layout, where the frontmatter
carried the folder's rules and the file could not govern itself — so every
newly seeded knowledge base started on the older format, and the one file
operators copy when writing their own `access.md` taught it. Its body now
declares the repository's rules and its frontmatter declares who may change
them (`owner: Admin`); the effective root model is unchanged
(`write: Admin`, `download: Admin`).

The body's prose moved into `#` comments, because that is the constraint the
format actually imposes: a body that does not parse as YAML naming at least
one verb falls back to the legacy reading, silently. The template's own
guidance said the opposite ("Frontmatter only — the body is ignored") and its
worked example showed the legacy shape; both now describe the two blocks, as
does the `AGENTS.md` access-control section that agents read before writing
an `access.md` of their own.
