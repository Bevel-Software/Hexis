---
write:
  - Admin
download:
  - Admin
owner: []
---

# Repository access

This file is the root of the access-control tree for this knowledge base. It grants
write access only to the `Admin` role by default. Subfolders can broaden or narrow
access by adding their own `access.md`.

See [roles.yaml](roles.yaml) for the identity → role mapping. Access resolution and validation
run in the Bevel platform.

## Adding a folder-level rule

Drop an `access.md` into any folder under an ontology's `Knowledge/`. Frontmatter
only — the body is ignored. Example:

```yaml
---
write:
  - Admin
  - Editor
  - Jane Doe <jane.doe@example.com>
  - deny Mallory Bad <mallory@example.com>
---
```

Each entry is either a grant (bare principal) or a denial (`deny <principal>` —
**lowercase `deny` only**; capitalised forms like `Deny` are treated as part of a
name). A principal is either a role name (matched case-insensitively against
`roles.yaml`) or a user reference in `Name <email>` form.
