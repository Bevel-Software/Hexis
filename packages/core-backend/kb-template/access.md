---
# Frontmatter governs THIS FILE — who may change the repository-wide rules below.
owner:
  - Admin
---
# Body governs the FOLDER. This is the root of the access-control tree, so every
# path inherits what is declared here unless a nearer access.md overrides it.
#
# Two blocks, two scopes: the frontmatter above is about this file, the body
# here is about the folder. Keep the body pure YAML and put prose in `#`
# comments like these — a body that does not parse as YAML naming at least one
# verb falls back to the older format, in which the FRONTMATTER carried the
# folder's rules. That fallback is silent.
#
# Verbs are read, write, download and owner. `owner` implies the rest and
# `write` implies `read`. Read is default-deny: a folder with no `read:` grant
# is invisible to everyone except admins, who read through `write: Admin`.
#
# Each entry is a grant (a bare principal) or a denial (the lowercase word
# `deny`, a space, then the principal — capitalised forms like `Deny` are
# treated as part of a name). A principal is a role name from roles.yaml
# (matched case-insensitively), a group name from groups.yaml, a person as
# `Name <email>`, or `everyone` — every signed-in person and their agents, the
# whole organisation. `read: everyone` in a folder's BODY opens that folder to
# all; the same line in a file's frontmatter only makes that one file visible.
#
# To tighten or widen a subtree, drop an access.md into any folder at any depth,
# with the same two blocks. For example, in KnowledgeBase/Finance/access.md:
#
#     ---
#     owner:
#       - Admin
#     ---
#     read:
#       - Finance
#     write:
#       - Admin
#       - Jane Doe <jane.doe@example.com>
#       - deny Mallory Bad <mallory@example.com>
#
# Resolution walks the repo root down to the file's own directory; for each
# principal, the closest rule naming them wins. Rules are enforced at runtime,
# so a malformed roles.yaml or access.md surfaces when access is resolved.
write:
  - Admin
download:
  - Admin
owner: []
