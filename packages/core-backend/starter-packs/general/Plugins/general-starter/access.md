---
# THIS BLOCK (the frontmatter) governs this access.md FILE only: who may
# see it and who may change it. `read: everyone` here means every signed-in
# person can see that the plugin exists. It admits nobody.
read:
  - everyone
---
# THIS BLOCK (the body) governs the PLUGIN FOLDER - its skills, tools and
# manifest. A starter plugin is for the whole team, so everyone may use it
# and admins change it. To narrow it, replace `everyone` under `read:` with a
# role from roles.yaml, a group from groups.yaml, or a person as
# `Name <email>`. Keep this block pure YAML; explanations go in `#` lines.
read:
  - everyone
write:
  - Admin
owner:
  - Admin
