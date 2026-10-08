## Access control

Access to any path — reading it as much as writing it — is governed by
`roles.yaml` (who has which role), `groups.yaml` (who is in which group) and
`access.md` files (who may do what, where).

- **Roles** in `roles.yaml` map a role name to a list of members: emails, and
  `group:<Name>` entries that give the role to a whole group (see *Giving a
  role to a group* below). Role names are
  case- and whitespace-insensitive (`Admin` = `admin` = `ADMIN`; `Product Team`
  = `product team`). The reserved names `deny` and `everyone` cannot be used, and neither can
  names starting with `role/` or `plugin/` — those spellings are tokens in
  access entries (below). One exception to the file's authority: the
  **deployment admin** — the address the server configuration sets as
  `ADMIN_EMAIL` — is **always an Admin**, whether or not `roles.yaml` lists
  it, and taking it out of the file does not change that. It is the rescue
  path for a `roles.yaml` that has lost its last Admin. The App roles page
  shows that account under Admin as a fixed member that cannot be added or
  removed there; every other Admin membership is exactly what the file says,
  and removing one takes effect on that person's next request.
- **Plugins are grantable principals.** `plugin/<name>/read`,
  `plugin/<name>/write` and `plugin/<name>/owner` in any access file mean
  everyone who currently holds that verb on the plugin whose manifest `name`
  is `<name>`, derived live from the plugin's own `access.md`. Any spelling
  folds to the identifier (`plugin/GTM/read` and `plugin/gtm/read` are one
  principal). This is how a shared skill is made visible to a plugin's
  members: `read: plugin/gtm/read` on the skill's folder.
  Adding or removing someone on the plugin changes what they can read
  everywhere the token is granted, with no copying.
- **Access rules** live in `access.md` files, which carry **two blocks with two
  scopes**: the BODY (below the closing `---`) declares the rules for the
  folder the file sits in, and the FRONTMATTER declares who may read and
  write that `access.md` itself. Each block names verbs (`read`, `write`,
  `download`, `owner`) whose entries are either grants (a bare principal) or
  denials (the lowercase word `deny`, a space, then the principal).
  Capitalised forms like `Deny` are *not* triggers; they are treated as part
  of a name.
- **Principals** are a role name from `roles.yaml`, a group name from
  `groups.yaml`, a person as `Name <email>`, a plugin token (above), or
  **`everyone`** — the built-in org-wide principal: every signed-in person and
  their agents. `read: everyone` in a folder's BODY opens that folder to the
  whole organisation; it is how an organisation-wide skill or plugin is
  shared. The same line in a file's FRONTMATTER only makes that one file
  visible — a plugin's `access.md` ships with `read: everyone` in its
  frontmatter so the plugin can be found and joined, and that admits nobody
  to the plugin itself. A person's personal plugin
  (`{{pluginsDir}}/personal-<id>/`) grants its owner access and denies
  `everyone` outright, so opening a parent folder never opens it.
  When a group and a role share a name, the bare name means the GROUP;
  `role/<Name>` (for example `deny role/Reviewer`) always means the role.
- **Keep an `access.md` body pure YAML**, with any explanation in `#` comments.
  A body that does not parse as YAML naming at least one verb is read in the
  older format instead, where the FRONTMATTER carried the folder's rules — so a
  stray line of prose silently changes which block governs the folder.
- **The verbs nest.** `owner` sits over `write` and `download`; `write` and
  `download` each sit over `read` — anyone who may edit a node, or save a copy
  of it, may also view it. `write` and `download` say nothing about each other.
  The nesting is GRANT-ONLY: a grant of a higher verb confers the lower ones,
  but `deny write` or `deny download` says nothing about `read` and never
  strips a separate read grant. So `download: Ana <ana@x.io>` alone lets Ana
  open the node as well as download it, and a `deny download` beside an
  inherited read leaves her able to open it but not save it.
- **You can only change what you can read.** Nothing is created, changed,
  moved into or removed from a place the caller cannot read — on every
  branch, drafts included, whatever `write:` rules say. A write tool refused
  for this says so (`write-denied`, naming the unreadable folder), and
  proposing is not offered either: a proposal into a folder its author cannot
  see would vanish from them the moment it landed. Two exceptions. A NEW
  FOLDER directly under `{{knowledgeBaseDir}}/`, `{{skillsDir}}/` or
  `{{pluginsDir}}/`: anyone may start one, whatever the root's rules grant
  them, and the new folder's `access.md` is seeded with the creator's own
  `read:` grant so what they put there is visible to them (a loose FILE
  directly at a root has no folder to carry that grant and is not excepted).
  And an Admin — or the deployment owner — may change the files directly in
  the repository root (`roles.yaml`, `access.md`, `groups.yaml`, …) even when
  the root grants read to nobody: the same rescue the write
  floor gives them, so a tree whose root rules lock everyone out stays
  repairable from inside the app. That rescue stops at the root; a subfolder
  an admin cannot read is closed to them like to anyone else.
- **Resolution** walks repo root → file directory, accumulating per-principal
  state. User-level entries trump role-level entries. A role denial removes
  only that role's contribution; it does not undo grants from other roles.
- **`roles.yaml` is editable only by Admin** — hard-coded in the resolver,
  never overridable by an `access.md`.
- **`access.md` files are picked up at any depth**, so a folder can tighten or
  widen what it inherited from its parent.
- **Per-file rules exist for Markdown notes and `.tool` definitions.** A note
  (`.md`, lowercase) may name verbs in its own frontmatter, and those rules
  apply to that one note; a `.tool` definition keeps the access verbs in its
  own YAML the same way; a distribution may register further file kinds
  that carry their own rules. Any other file (a PDF, a presentation, a
  spreadsheet, an image, any binary, a `.markdown` or `.MD` file, or binary
  content saved as `.md`) takes its folder's rules: sharing it on its own is refused with
  `folder-governs-access`, naming the folder. To change who
  can open such a file, change its folder's `access.md`, or move the file to a
  folder whose rules fit.

Rules are enforced at runtime; a malformed `roles.yaml` or `access.md` surfaces
when access is resolved.

### Roles are pre-set — a "new role" is usually a group

**What a role is.** A role in `roles.yaml` is an app role: a capability the
platform defines and acts on (`Admin` is one), listed with the people who hold
it. The set of roles is pre-set by the platform. A role is not a way to name a
team.

**Agents never create roles.** Add people to a role that already exists, or
remove them, and nothing more: never add a role name to `roles.yaml`, and never
rename one — a rename is a delete plus a create. Such a write is refused with a
422 that names the role and says: app roles are pre-set — add people to
existing roles, and use a GROUP for a task- or team-scoped set of people.
Relay that refusal to your user as it stands; do not look for another way to
write the file.

**Is it really a group?** When someone asks for a "new role", it almost always
is. It is a group when any of these hold:

- the name says who the people are — a team, a project, a customer, a
  committee — rather than a capability the platform already has;
- it would change or disappear when the project ends or the team reshuffles;
- its purpose is to give those people access to some folders or files.

A request that matches a role that already exists is membership, not a new
role.

**What to do instead.**

1. If an existing role already carries the capability, add the people to it.
2. Otherwise make it a group: add or extend the group in `groups.yaml` (or
   point your user at the app's Groups page), then grant the group in the
   `access.md` of the folders it should reach.
3. If your user still needs a role the platform does not have, that is not an
   edit you can make — say so, and leave the decision to an admin.

### Giving a role to a group

A role's member list takes a group as well as individual emails. Write the
entry as `- group:<Name>`, where `<Name>` is a group in the active group
source — `synced-groups.yaml` when the deployment syncs groups from an
identity provider, `groups.yaml` otherwise. Here a `Reviewer` role the
deployment already has goes to a whole group:

```yaml
roles:
  Admin:
    - dana@example.com
  Reviewer:
    - lee@example.com
    - group:Platform Team
```

- **Matching.** The name is matched case- and whitespace-insensitively against
  the active group source, like role names: `group:platform team` and
  `group:Platform  Team` are the same entry as `group:Platform Team`.
- **Unknown groups are refused.** An entry naming a group the active source
  does not declare is a validation error: the write is refused with a 422
  that names the entry and its role (`'- group:Platfrom Team' under role
  'Reviewer'`), and nothing is saved. Create the group first, or fix the name.
- **A group under `Admin` makes every member a full admin** — including anyone
  added to the group later, and including the right to edit `roles.yaml`
  itself. Only make that edit when your user is an Admin and explicitly asks
  for exactly that, and say so in the commit summary; for anyone else, tell
  them what it would mean and who can do it (below). `Admin` must also always keep at least one
  direct email member; a group entry alone is not enough, so a broken
  directory can never leave the deployment without an admin.
- **With direct emails.** Group entries and emails add up: the role's members
  are everyone listed by email plus everyone currently in each listed group.
  A person in both is simply a member; adding or removing someone from the
  group changes the role with no edit to `roles.yaml`.
- **With denials.** Group members hold the role's grants exactly as if they
  were listed by email. A denial of the role in an `access.md`
  (`deny role/Reviewer`) therefore removes the role's contribution for
  everyone in the group, as it does for the emails. Write the `role/` form:
  a bare `deny Reviewer` would deny a group named `Reviewer` instead, if one
  exists. The nearest `access.md` that says
  anything about the person decides: a person granted by name
  (`Name <email>`) in the SAME `access.md` as the denial keeps that access,
  because within one file a person's own entry beats a role entry. A grant by
  name in a folder further up does not survive a role denial closer to the
  file.

**Only an Admin changes `roles.yaml`, and only on the default branch.** A
change request cannot carry the edit: when a request is merged, `roles.yaml`
is restored to what the default branch has, so a role edit drafted on a
branch is dropped at the merge without a word. Do not propose one. If your
user is an Admin, `edit_file` the file on the default branch directly — for
example, to give the Reviewer role to a group, add the entry under the
existing role:

```yaml
roles:
  Admin:
    - dana@example.com
  Reviewer:
    - lee@example.com
    - group:Platform Team   # added
```

If your user is not an Admin, tell them who is (the `Admin` entries in
`roles.yaml`) and that the change is made in the app's Roles page or by an
admin editing the file; do not open a change request for it.

### Direct writes vs change requests

File-level write access decides how a change lands on the default branch:

- A user — or an agent acting as that user — whose access resolution grants
  **write or owner on every file the change touches** may commit **directly**
  to the default branch.
- Without that access, the change goes through a **branch + change request**,
  approved by an owner / write-access holder of the affected files — every
  affected file with an eligible approver needs that approval, whatever its
  type (notes, binary files, files without an extension).
- Agents carry exactly their user's access, never more. Before writing to the
  default branch, **ask the user** whether to write directly or go through the
  review flow — and prefer a change request when in doubt, when the change is
  large, or when it touches content the user does not own.

### An agent proposes and syncs; a person merges

- **Propose** with `open_change_request`, then give the user the request's
  `url`. Reviewing, approving and merging a change request happen in the app,
  by a person — no agent tool approves a file, bypasses approval, or merges a
  request. `merge_change_request` no longer exists.
- **Sync** a draft with `merge_branch`, `source` = the branch the request
  targets, `target` = the draft. This is allowed while the draft's request is
  open, and is how you bring it up to date or surface conflicts to resolve on
  the draft.
- `merge_branch` refuses to merge a draft into the branch its open change
  request targets — it names the request; ask the user to review it in the
  app. Into a protected branch it merges only what you could commit there
  directly, under the rule above — and never a change to `roles.yaml`, whoever
  you are: roles are changed in the app, not merged in from a draft.
- **Delete** a draft with `delete_branch`, which removes it for everyone. Only
  its author (`<email-localpart>/…`, or your own `suggestions/…` bundle) or an
  Admin may. Preview with `dryRun: true` first: it changes nothing and says
  whether the delete would go through, how many commits are not on the default
  branch, and the last commit. A branch holding such commits is refused unless
  you pass `discardUnmerged: true` — only when the user wants that work gone. An
  open change request from or into the branch that proposes nothing is closed
  by the delete. One that still proposes something refuses it, with a link:
  its author can withdraw it, or an Admin can decline it, in the app — hand the
  user that link. Hand the user the
  `lastCommit` it answers, so the branch can be restored. The server removes a
  draft on its own once its change request was merged, but only while nothing
  has happened to it since: no commit that is not on the default branch, no
  request open from or into it, no save still landing, and its last commit
  the one that was merged. Any other draft stays until someone deletes it.
