## Access control

Who may read and change each path, on every branch, is set by three kinds of
file: `roles.yaml` (who holds which role), `groups.yaml` (who is in which
group) and `access.md` files (who may do what, where). A folder everyone may
read and the Platform Team may change has this `access.md`:

```yaml
---
owner:
  - Admin
---
read:
  - everyone
write:
  - Platform Team
```

- **An `access.md` has two blocks.** The body, below the closing `---`, holds
  the rules for the folder the file sits in. The frontmatter above it says who
  may read and change that `access.md` itself. Keep the body pure YAML, with
  any explanation in `#` comments: a body that does not parse as YAML naming at
  least one verb is read in an older format, where the frontmatter carried the
  folder's rules.
- **Verbs and entries.** The verbs are `read`, `write`, `download` and
  `owner`. Each verb takes a list, one entry per line, as above: a one-line
  value such as `write: everyone` does not parse, and the whole file is
  skipped. Each entry is a grant (a principal) or a denial (the lowercase word
  `deny`, a space, then the principal). `Deny` with a capital is part of a
  name, not a denial.
- **Verbs nest.** `owner` includes `write` and `download`, and each of those
  includes `read`: a grant gives the verbs below it, so a `download` grant
  alone lets a person open a page as well as save a copy.
  A denial takes away the verbs above it: `deny read` also removes `write`,
  `download` and `owner`, and `deny write` removes `owner`. `deny write` and
  `deny download` never remove `read`.
- **Principals** are a role from `roles.yaml`, a group from `groups.yaml`, a
  person as `Name <email>`, a plugin token, or **`everyone`**: every signed-in
  person and their agents. `everyone` under `read` in a folder's body opens the
  folder to the organisation; in a file's frontmatter it only makes that file
  visible (a plugin's `access.md` has it there so the plugin can be found and
  joined, which admits nobody to the plugin). When a group and a role share a name,
  the bare name means the group and `role/<Name>` the role. A person's
  personal plugin (`{{pluginsDir}}/personal-<id>/`) grants its owner access and
  denies `everyone` outright, so opening a parent folder never opens it.
- **Plugin tokens.** `plugin/<name>/read`, `plugin/<name>/write` and
  `plugin/<name>/owner` mean everyone the body of that plugin's own
  `access.md` grants that verb or a higher one (grants inherited from folders
  above the plugin, and `deny` lines, do not count). `<name>` is the
  manifest's `name`, in any spelling. This is how a shared skill reaches a
  plugin's members: `plugin/gtm/read` under `read` on the skill's folder.
  Joining or leaving the plugin changes what they can read wherever the token
  is granted.
- **The nearest rule decides.** For a path, the platform looks at the file's
  own rules (below), then its folder's `access.md`, then each folder above, up
  to the root, and the first one that says anything about you decides. Within
  one file, a rule naming you beats one for your roles or groups; a grant
  through one of your roles beats a denial through another; `everyone` comes
  last. No rule anywhere means no access: a folder no rule opens to you is
  invisible to you.
- **Per-file rules** exist for markdown notes (`.md`, lowercase) and `.tool`
  files: verbs in a note's frontmatter, or in a `.tool`'s YAML, apply to that
  file alone. Any other file (a PDF, an image, a spreadsheet, a `.markdown` or
  `.MD` file) takes its folder's rules, and sharing it on its own is refused
  with `folder-governs-access`, naming the folder. Change the folder's rules,
  or move the file to a folder whose rules fit.
- **You can only change what you can read**, on every branch, drafts
  included, whatever `write` says. Such a write is refused with `write-denied`,
  naming the place you cannot read, and proposing it is not offered: it would
  vanish from you the moment it landed. Two exceptions. Anyone may start a new
  folder directly under `{{knowledgeBaseDir}}/`, `{{skillsDir}}/` or
  `{{pluginsDir}}/`, and its `access.md` is seeded with the creator's own read
  grant (a loose file directly at a root is not excepted); on a protected
  branch you still need write there, so start it on a draft. And an Admin may
  always change the files at the repository root (`roles.yaml`, `access.md`,
  `groups.yaml`), so a tree that locks everyone out stays repairable.
- **Broken rules.** A `roles.yaml` that does not parse stops access from
  resolving until it is fixed. An `access.md` that does not parse is skipped
  (its folder then follows the folders above it) with no error you can see, so
  after editing one, check the result with `file_stat` and `explainAccess`.

### Roles are pre-set: a "new role" is usually a group

**What a role is.** A role in `roles.yaml` is an app role: a capability the
platform defines and acts on (`Admin` is one), with the people who hold it. The
set of roles is pre-set. A role is not a way to name a team. The deployment
admin (the server's `ADMIN_EMAIL`) is always an Admin, whatever the file says.

**Agents never create roles.** Add people to a role that exists, or remove
them, and nothing more: never add or rename a role in `roles.yaml`. Such a
write is refused with a 422 saying that app roles are pre-set: add people to
existing roles, and use a GROUP for a task- or team-scoped set of people.
Relay that to your user as it stands; do not look for another way in.

**Is it really a group?** It is when the name says who the people are (a team,
a project, a customer) rather than a capability the platform has, when it
would change when the project ends or the team reshuffles, or when its purpose
is to give those people access to some folders. A request that matches an
existing role is membership, not a new role.

**What to do instead.** Add the people to an existing role that carries the
capability. Otherwise make it a group: add it to `groups.yaml` (or point your
user at the app's Groups page), then grant the group in the `access.md` of the
folders it should reach. A role the platform does not have is an admin's
decision, not an edit you can make.

### Giving a role to a group

A role's members may include a group: write `- group:<Name>`, naming a group
in the active group source (`synced-groups.yaml` when groups are synced from
the organisation's directory, `groups.yaml` otherwise):

```yaml
roles:
  Admin:
    - dana@example.com
  Reviewer:
    - lee@example.com
    - group:Platform Team
```

- **Matching** is case- and whitespace-insensitively against the active group
  source, as for role names.
- **An unknown group is a validation error**: the write is refused with a 422
  naming the entry and its role, and nothing is saved.
- **A group under `Admin` makes every member a full admin**, including anyone
  added to the group later. Make that edit only when your user is an Admin and
  asks for exactly that, and say so in the summary. `Admin` must keep at least
  one member listed by email.
- **Members add up**: the role's members are the emails listed plus everyone
  currently in each group.
- **A denial** of the role (`deny role/Reviewer`) removes the role's
  contribution for everyone in the group, as for the emails. Write the `role/`
  form: a bare `deny Reviewer` denies a group of that name if one exists.

**Only an Admin changes `roles.yaml`, on a protected branch, directly.** On a
draft anyone who can read the file may save it, but a merge puts back the
target branch's copy, so a role edit drafted on a branch is dropped without a
word. Do not propose one. If your user is an Admin, `edit_file` the file on
`{{defaultBranch}}`. If not, tell them who the Admins are (the `Admin` entries)
and that the change is made in the app's Roles page or by an Admin.

### Before you say or change who has access

Look it up, folder by folder: one folder's rules say nothing about another's.
`file_stat` on each path that matters, with `explainAccess: true`, lists who
holds each verb (`roster`, when you may manage the path's access); the active
group source (`synced-groups.yaml` when groups are synced, `groups.yaml`
otherwise) says who is in each group, the person you are helping included. It
does not judge one named person for you. Then name the people: who can do it
now and, for a move or a rule change, who gains and who loses. When they
already have it, say so and change nothing. A change nobody needed still
widens or narrows access for everyone the rule names.

### Direct writes vs change requests

- A person, or an agent acting for them, with **write or owner on every file a
  change touches** may write directly to a protected branch. Ask the person
  first, and prefer a change request when in doubt, when the change is large,
  or when it touches content they do not own.
- Without that access, the change goes through a **draft and a change
  request**, approved by an owner or writer of each affected file that has one.
  Agents carry exactly their user's access, never more.
- **Check `canWrite` before offering a direct write.** `list_skills` reports
  it for a skill's `SKILL.md`; `get_skill` for every file of the skill (or, with
  `file`, for that file alone); `list_files` and `read_file` per path. It
  answers for `{{defaultBranch}}` under the rules committed there, whichever
  branch you read. `false` means use a draft and a change request. A read-only
  connection gets `false` everywhere and can do neither. To explain a verdict,
  call `file_stat` on `{{defaultBranch}}` with `explainAccess: true`: it says
  why, and, when you may manage that path's access, who holds each verb (who
  can approve). For `roles.yaml`, `false` means an Admin's change, not a
  request.
