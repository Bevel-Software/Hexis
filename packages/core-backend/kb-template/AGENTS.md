---
# This file's own access rule: readable by every signed-in person and their
# agents, whatever the root access.md says. Agents are told to read this file
# before their first action, and the root rules grant read to nobody by
# default — without this line a non-admin's agent would fail on step one.
read:
  - everyone
---
# Knowledge base

This is a git-backed knowledge base. You are the primary agent responsible for
maintaining it.

> **This file is managed by the platform.** Every server restart replaces it
> with the current template, so edits made here are overwritten. Deployment- or
> team-specific conventions belong in files of your own — anywhere under
> `{{knowledgeBaseDir}}/`, linked from wherever they are needed.

**Read `mcp-description.md` at the repository root first.** It says what this
knowledge base contains and when to consult it. Agents connected over MCP
receive the default branch's copy inline at the start of every session; a
clone like this one reads the copy on its own branch.

**There is no required format for knowledge.** Write markdown the way the
subject wants to be written: prose, tables, checklists, diagrams, whatever
serves the reader. Nothing here parses your files into a schema or rejects a
document for having the wrong shape. If a deployment layers a structured
knowledge graph on top, it brings its own conventions and its own guide; this
one describes the platform underneath, which stores files and controls who may
change them.

## Directory Structure

```text
knowledge-base/
├── {{knowledgeBaseDir}}/        ← the knowledge itself; organise it however suits you
├── {{skillsDir}}/               ← shared skills, organised by who owns them
├── {{pluginsDir}}/              ← one folder per plugin: its tools, and links to skills
├── roles.yaml            ← identity → role mapping (Admin-only edits)
└── access.md             ← repo-root access-control rules
```

(The three root names above are this deployment's own — a deployment may
rename them in its setup screen, and this guide is rendered with the names in
effect each time it is written.)

Tool paths are workspace-relative, and the workspace root holds this
repository as the `knowledge-base/` folder: a file in it is
`knowledge-base/{{knowledgeBaseDir}}/Foo.md`, never `{{knowledgeBaseDir}}/Foo.md`. A path
without that prefix is refused, because it would land beside the repository
where git never sees it.

Only those three folders are structural. `{{skillsDir}}/` holds shared skills at any
depth — the folder that holds a `SKILL.md` is the skill, and everything above
it is ownership (`{{skillsDir}}/<scope>/…/<skill>/SKILL.md`, with an `access.md` in
any scope folder that needs its own rules). `{{pluginsDir}}/` has a layout the
platform reads:

```text
{{pluginsDir}}/<Plugin>/plugin.json                  the manifest (Agent Plugins) — what makes the folder a plugin; its `name` is the plugin's identity
{{pluginsDir}}/<Plugin>/skills/<skill>/SKILL.md      a skill that lives inside the plugin
{{pluginsDir}}/<Plugin>/mcp.json                     MCP servers (authoritative)
{{pluginsDir}}/<Plugin>/software.bevel.hexis/tools/  `.tool` manuals
{{pluginsDir}}/<Plugin>/access.md                    who can read/write the plugin
{{pluginsDir}}/personal-<user-id>/…                  one per person: private
```

**The manifest's `name` is the plugin.** It is a kebab-case identifier
(`sales-team`), and it is what every grant spells (`plugin/sales-team/read`),
what the URLs and the catalog key on, and what the compiled marketplace
publishes the plugin as. `displayName` is what people see it called ("Sales
Team"); absent, the folder name is shown. Rename a plugin from its page in the
app: an identifier change rewrites every grant that names it, in one commit —
editing `name` by hand leaves those grants pointing at a plugin that no longer
exists.

**A plugin LINKS shared skills rather than containing them.** Its manifest
lists skill paths under `extensions["software.bevel.hexis"].skills` — each
entry is one skill folder or a folder of skills under `{{skillsDir}}/`:

```json
{ "extensions": { "software.bevel.hexis": { "skills": ["{{skillsDir}}/Engineering/deploy", "{{skillsDir}}/Sales"] } } }
```

One skill, stored once, can be listed by many plugins. A plugin's effective
skills are the ones inside its folder plus everything its links resolve to.
Do not edit that list by hand: linking is done from the plugin's page in the
app, because it is two edits at once — the manifest entry AND a grant on the
skill (see *Access control* below). A manifest entry without the grant lists
a skill the plugin's members cannot read; the app shows such a link as
needing setup and offers Repair.

**Ownership decides who may read a skill, never the plugin.** A shared
skill's readability comes from the `access.md` rules on its own folder and
the scopes above it. A plugin that links a skill someone cannot read simply
does not show it to them.

**Symlinks are not supported anywhere under `{{pluginsDir}}/`.** Access control
resolves rules by path, and a symlink is a second path to the same content —
the two can disagree about who may read what. The platform never creates
them and ignores any it finds (they can only arrive via a direct git push).

**A plugin follows the [Agent Plugins](https://agent-plugins.org) specification**
(v1.0.0), so another conformant client can load one: it reads `plugin.json`, the
skills under `skills/`, and the servers in `mcp.json`, and ignores everything
else. Two things here are ours and sit outside that portable core. `access.md`
stays at the plugin root because access resolution walks root → file, so the
same rules one level down would govern only that subtree. And `http`/`inline` `.tool`
manuals live under the reverse-DNS `software.bevel.hexis/` namespace, because
the specification describes MCP servers only and has no way to express them.

**MCP servers belong in `mcp.json` — do not write `.tool` files for them.**
Each `mcpServers` key is the server's identity: it is the namespace its vault
secrets bind to (`<name>_<VAR>`), so renaming a key unbinds every configured
secret and sign-in. The portable entry carries only where the server is
(`type`, `url`, literal headers). Anything this platform needs beyond that —
auth headers carrying `${VAR}` vault references, `variables` declarations,
a `description`, or `local: true` for a server only reachable from a user's
machine — goes in `plugin.json` under
`extensions["software.bevel.hexis"].mcpServers[<name>]`, which other clients
ignore by design. A `type: "stdio"` entry (a command run on the user's own
machine) is always local: the hosted endpoint never spawns it; the local
`hexis-mcp` server fetches the plugin's files to a local directory and runs it
per the Agent Plugins runtime contract (`PLUGIN_ROOT`/`PLUGIN_DATA`, `./`
commands contained to the plugin). A stdio server SHOULD exit when its stdin
reaches EOF — the client also terminates it on shutdown, but a server that
ignores EOF outlives crashes as an orphan whose working directory blocks the
plugin folder from ever refreshing.

**Secrets are never written into a plugin's portable files.** The specification
defines no portable credential mechanism on purpose: authorization and
credential storage are the client's business, header and `env` values are
"visible package data", and a client must not expand anything except
`${PLUGIN_ROOT}` and `${PLUGIN_DATA}`. So the Secrets Vault IS this platform's
answer to that — and `mcp.json` carries only where a server is, never a
`${VAR}` reference to how to authenticate with it. Those live in `plugin.json`
under `extensions["software.bevel.hexis"].mcpServers[<name>]`, which is ours
to interpret and which other clients ignore by design.

**Plugin folders are made through the platform, not by writing files.** A
folder is a plugin exactly when it carries a `plugin.json` (the platform
writes one into every legacy plugin folder at startup), and it is LISTED only
when it also carries an `access.md` — a bare directory under `{{pluginsDir}}/` is
neither. Plugins may sit at any depth under `{{pluginsDir}}/`; a folder that holds
plugins deeper down is a grouping folder, not a plugin. A new plugin needs an
`access.md` naming who runs it, and the write gate refuses a plain write
into an unused name there — so do not try to create a plugin by writing a
skill into `{{pluginsDir}}/<new-name>/…`; it will be denied. Use the two tools
instead:

- `my_plugin` — your user's own private space, created on first use:
  `{{pluginsDir}}/personal-<id>/`. Readable only by its owner — not even
  admins — and never listed as a plugin. Their personal skills go under its `skills/`,
  each in its own folder with a `SKILL.md`; write there with the file tools.
- `create_plugin` — a shared plugin, named, optionally inside a grouping
  folder under `{{pluginsDir}}/` (`parent`). The caller runs it; others join
  through the app or are granted in its `access.md`.

The app's **New plugin** button and `POST /api/plugins` do the same. A skill
moves from a personal space into a plugin by moving its folder.

Everything under `{{knowledgeBaseDir}}/` is yours to arrange. Subfolders, naming,
whether a topic is one file or twenty — all of it is a judgement call about
what the next reader needs, not a rule the platform enforces.

A deployment may reserve further root folders of its own — `Data/`, `Agents/`
and `Pipelines/` scaffold an agentic execution layer in some installations.
They are not part of this template and are not created here; where they exist,
each carries its own `README.md` describing what belongs in it.

## Where a new file goes

Decide by what the file IS, not by which folder you already hold rights in.
Write access is not evidence that a file belongs somewhere.

- **Any document goes under `{{knowledgeBaseDir}}/`.** Knowledge, notes,
  reports, tickets, specifications, plans, meeting minutes — anything written
  to be read by a person. That is what the root is for, and its shape inside
  is yours to choose.
- **A shared skill goes under `{{skillsDir}}/`**, or under
  `{{pluginsDir}}/<Plugin>/skills/<skill>/SKILL.md` when it belongs to one
  plugin alone. A person's private skill goes in their own space (`my_plugin`).
- **Tool manuals, MCP server declarations and manifests go inside a plugin:**
  `.tool` manuals under `{{pluginsDir}}/<Plugin>/software.bevel.hexis/tools/`,
  servers in that plugin's `mcp.json`, and `plugin.json` at its root.
- **A plugin folder never holds a document.** `{{pluginsDir}}/` carries
  machinery — manifests, tool manuals, server declarations, access rules, and
  the skills a plugin owns. A ticket or a report written there is filed where
  nobody will look for it, under rules written for tools.
- **When the place named does not exist, or nothing fits, ask.** If the user
  names a folder that is not there, or the file is of a kind this deployment
  has made no home for, say so and ask where it should go. Do not settle for a
  folder you happen to be able to write to; a wrong guess is discovered much
  later than a question.

## Access control

Access to any path — reading it as much as writing it — is governed by
`roles.yaml` (who has which role), `groups.yaml` (who is in which group) and
`access.md` files (who may do what, where).

- **Roles** in `roles.yaml` map a role name to a list of members: emails, and
  `group:<Name>` entries that give the role to a whole group (see *Giving a
  role to a group* below). Role names are
  case- and whitespace-insensitive (`Admin` = `admin` = `ADMIN`; `Product Team`
  = `product team`). The reserved name `deny` cannot be used, and neither can
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
  to the plugin itself. A person's own space (`{{pluginsDir}}/personal-<id>/`)
  denies `everyone` outright, so opening a parent folder never opens it.
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
  the repository root (`roles.yaml`, `access.md`, `groups.yaml`, `AGENTS.md`,
  …) even when the root grants read to nobody: the same rescue the write
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
- **Per-file rules exist for Markdown notes only.** A note (`.md`, lowercase)
  may name verbs in its own frontmatter, and those rules apply to that one
  note. (A `.tool` definition keeps the access verbs in its own YAML the same
  way.) Every other file (a PDF, a presentation, a spreadsheet, an image, any
  binary, a `.markdown` or `.MD` file, or binary content saved as `.md`)
  takes its folder's rules: sharing it on its own is refused with
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
  itself. Only propose it when your user explicitly asks for exactly that, and
  say so in the change request. `Admin` must also always keep at least one
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

**Editing `roles.yaml` goes through a change request** unless your user is an
Admin: only admins may write the file on the default branch. Draft the edit
on a branch and open a change request for an admin to approve:

1. `create_branch` with `name: dana/platform-team-reviewer` and `branch` set
   to the default branch.
2. On that draft, `edit_file` `roles.yaml`, adding the entry under the
   existing role:

   ```yaml
   roles:
     Admin:
       - dana@example.com
     Reviewer:
       - lee@example.com
       - group:Platform Team   # added
   ```

3. `commit_change` with `summary: "Give the Reviewer role to the Platform Team group"`.
4. `open_change_request` with `sourceBranch: dana/platform-team-reviewer`,
   the default branch as `targetBranch`, and a title such as `Give Reviewer
   to the Platform Team group`. Tell your user an admin must approve it
   before the role takes effect.

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

## Skills (`{{skillsDir}}/<scope>/…/<skill>/SKILL.md`, or `{{pluginsDir}}/<Plugin>/skills/<skill>/SKILL.md`)

A skill is a folder holding a `SKILL.md` and whatever files it needs. Shared
skills live under `{{skillsDir}}/`, organised by ownership; a skill that belongs to
exactly one plugin may live inside that plugin's `skills/` folder instead.
Skill names are unique across the whole catalog, whichever home they have.
The frontmatter names it, declares which tools it may use, and may carry a
version:

```yaml
---
name: weekly-newsletter
description: Drafts the Friday newsletter for review.
allowed-tools: [slack_post_message]
metadata:
  version: "1.4.0"
---
```

The body is the instructions, in plain markdown. `allowed-tools` entries are
tool names from the `.tool` manuals and MCP servers of the plugins that hold
the skill. `metadata.version` is semver. Any other `metadata` keys are the
author's own notes — the catalog carries the file as it is and acts on none
of them.

A `SKILL.md` committed on the default branch is listed and loadable from the
very next `list_skills` or `get_skill`, on the connection you already have:
skills are read from the workspace on every request, on either connection.
See *A released tool or skill is live within five seconds* under **Tool
Manuals** for the one caveat (an MCP client that caches the prompt list it
was given at connect time must re-list — the prompt-list-changed notification
that tells it to arrives within five seconds of the commit, whether or not
anyone is using the connection).

**How skills reach agents.** Through the MCP server (`list_skills`,
`get_skill`), or as native plugins: every user can clone a git remote from
the app's external-agent page that holds a plugin marketplace compiled from
exactly the skills they may read — one plugin per plugin here, a
`skills-and-knowledge` plugin for the rest plus this knowledge base's MCP
server, and `hexis-all`, one plugin holding every skill they may read and
the MCP server, for a single install.

## Tool Manuals (`{{pluginsDir}}/<Plugin>/software.bevel.hexis/tools/*.tool`)

Each plugin folder holds `*.tool` files — reusable **tool manuals** that let agents call external APIs. They are **not part of the knowledge graph** (never modelled as nodes) and are access-controlled like any other file via `access.md`. Any user who can *read* a `.tool` can use its tools; anyone who can *write* it sets its shared (admin) secrets (see below). Put each manual in the plugin's `software.bevel.hexis/tools/` directory, beside
the skills that use it. The same integration may exist in several plugins as
separate files (`Everyone/…/serper.tool` and `Finance/…/serper.tool`), each
with its own credentials and access rule — a plugin is a folder, not a registry
of unique names. Remember: `.tool` files are for `http` and `inline` manuals
only; MCP servers belong in `mcp.json`.

A `.tool` file is JSON or YAML. Its `type` decides how tools are discovered:

- **`inline`** — the tools are embedded in the file (no network round-trip to list them).
- **`http`** — `url` points to an endpoint that returns a UTCP manual.

(`type: mcp` is the LEGACY spelling of an MCP server as a `.tool`. The boot
migration converts such files into `mcp.json` entries; do not write new ones.)

**The tool is the frontmatter.** A `.tool` is one `---` YAML block holding *everything* — its `id`, its access verbs (`read:`/`write:`/`owner:`/`download:`), and its config (`type`/`url`/`variables`/…) — all in the same object. Anything after the closing `---` is free-form notes the parser ignores (like a `SKILL.md` body):

```yaml
---
id: my_tool
write:
  - Product Team
owner:
  - Jane Doe <jane@x.com>
type: http
url: https://api.example.com/utcp
---
```

(A file with no `---` fence is the legacy form — the whole file is the object, so a bare JSON `.tool` still works.)

**`id` = variable namespace.** The `id` is the manual's stable identity: it's the UTCP namespace secrets bind to (`<id>_<VAR>`) and its route slug. It must be lowercase `snake_case` and **unique** across all `.tool` files. Resolution is `id` → `name` → the file name (so a `name:` alone works, same as the id system uses for every file). If two files collide, the one saved most recently through the app is auto-suffixed (`my_tool` → `my_tool2`). **Access** declared here gates who can use and edit that tool, exactly like a node's own frontmatter (most specific; overrides the folder `access.md`).

**Frontmatter `id` = address.** This is generic, not tool-specific: ANY `.md` or `.tool` file whose frontmatter declares an `id` (or a lowercase snake_case/kebab `name`) is addressable at `/workspace/<branch>/<id>` in the app, exactly like a knowledge node — tools, skills (`SKILL.md`), and plain notes alike. Graph nodes win an id collision; files without frontmatter stay path-addressed.

**Remote vs local (`remote`).** A tool is available to remote agents by default. Add `remote: false` for a tool that only works on the user's own machine (e.g. an `http` manual whose `url` is on `localhost`): the hosted remote MCP endpoint cannot reach it, so it skips the tool and advertises it through the `list_local_tools` tool instead. (An MCP server that is local-only declares `local: true` in the plugin.json extensions block instead — see above.)

To actually USE those tools, run the workspace as a local MCP server:

```
npx @bevel-software/hexis-mcp --url <workspace-url> --key <connection-key>
```

It serves everything the hosted endpoint serves **plus** the local-only tools, because it runs on the machine where they exist. Remote tools still execute on the server, so their shared keys and OAuth sign-ins keep working untouched; a local-only tool's own `${VAR}`s come from the environment of whatever launched the command (your MCP client's config), since the Secrets Vault never leaves the server. Reading the `.tool` and wiring the server into your client by hand still works and is the fallback when the command is unavailable.

### Referencing secrets — `${VAR}` and the `variables` block

Anywhere a `.tool` needs a credential (an API key, a token) write a placeholder like `${API_KEY}`. At call time it is filled from the **Secrets Vault** under the key `<id>_<VAR>`, where `<id>` is the manual's resolved id (the same `id` → `name` → file-name resolution described above) — so a manual whose id is `weather` referencing `${API_KEY}` reads the secret `weather_API_KEY`. A secret is therefore bound to exactly one manual; another manual cannot read it.

Declare who provisions each variable with an optional top-level `variables` array. Each entry is `{ name, scope, label? }`:

- **`scope: admin`** (the **default**) — set **once by a writer** of this `.tool` file; the same value is shared by everyone who uses the tool. Prefer this: keep as much as possible owned by the tool author.
- **`scope: user`** — set by **each end user** for themselves (their own value, never shared).

`name` must match `[A-Za-z0-9_]+`. A referenced `${VAR}` that you don't declare defaults to `admin` — and it still SURFACES automatically: the app detects every `${VAR}` the file actually references and shows it in the secrets UI, so the `variables` block is only needed to change a variable's scope to `user`, give it a label, or declare an OAuth sign-in. Values are entered in the Secrets Vault UI (or the `.tool` editor's sidebar), never in the file itself. A malformed `variables` entry makes the whole file fail to load, so it is never silently mis-scoped.

### Declaring an OAuth sign-in — the `oauth` block

A `user`-scoped variable can be filled by **signing in** instead of by a typed value: add an `oauth` block and each member authorizes with the provider; the token then rides in whatever header references `${VAR}`. The block carries PUBLIC config only:

| field | | |
|---|---|---|
| `clientId` | required | the OAuth app's client id — the tool owner registers the app with the provider, using the redirect URI `<backend>/api/secrets/oauth/callback` |
| `authorizationUrl`, `tokenUrl` | **optional on an `mcp.json` server**, required in a `.tool` | leave both out on an MCP server: they are discovered from the server's own OAuth metadata. Give both or neither. |
| `scopes` | optional | `string[]`, requested at sign-in and required back from the token |
| `pkce` | optional, default **on** | PKCE S256 — MCP servers require it; providers without it ignore it. Only `false` is meaningful. |
| `resource` | optional | RFC 8707 resource indicator (the MCP server URL); discovered on an `mcp.json` server |
| `authParams` | optional | extra static authorize params, e.g. Google's `access_type: offline` |

**Never** a `clientSecret` — a `.tool` carrying one fails to load, and an `mcp.json` server whose plugin.json entry carries one is dropped from the catalog. The secret is pasted once by a tool writer on the tool's page, then every member signs in on the Connect page.

For an `mcp.json` server the declaration lives in `plugin.json`, in the same extensions entry as the auth header that uses it:

```json
{
  "extensions": {
    "software.bevel.hexis": {
      "mcpServers": {
        "hubspot": {
          "headers": { "Authorization": "Bearer ${HUBSPOT_TOKEN}" },
          "variables": [
            { "name": "HUBSPOT_TOKEN", "scope": "user", "label": "HubSpot sign-in",
              "oauth": { "clientId": "<the app's client id>" } }
          ]
        }
      }
    }
  }
}
```

That is the whole declaration: endpoints, PKCE and the resource indicator come from the server. Add `authorizationUrl`/`tokenUrl` only when `list_tool_setup` reports in `setup.reason` that they could not be discovered.

### Examples

An `http` manual that authenticates with a shared org key and a per-user key:

```yaml
name: weather
type: http
url: https://api.weather.example/utcp
headers:
  Authorization: Bearer ${ORG_KEY}
  X-User-Key: ${USER_KEY}
variables:
  - { name: ORG_KEY,  scope: admin, label: "Org-wide weather.com key" }
  - { name: USER_KEY, scope: user,  label: "Your personal weather.com key" }
```

An `inline` manual with one tool:

```json
{
  "name": "billing",
  "type": "inline",
  "variables": [{ "name": "BILLING_KEY", "scope": "admin" }],
  "tools": [
    {
      "name": "create_invoice",
      "description": "Create an invoice.",
      "inputs": { "type": "object", "properties": {} },
      "outputs": { "type": "object", "properties": {} },
      "tool_call_template": {
        "call_template_type": "http",
        "http_method": "POST",
        "url": "https://api.billing.example/invoices",
        "headers": { "Authorization": "Bearer ${BILLING_KEY}" }
      }
    }
  ]
}
```

### Adding a third-party tool

When asked to add/integrate a product as a tool (e.g. "add Notion", "wire up Linear"), **never invent an endpoint or write a placeholder URL** — a `.tool` pointing at a made-up host is useless:

1. **Find the real endpoint from the vendor's own docs.** Prefer the vendor's official **remote MCP server** if one exists; otherwise fall back to their **REST API** base. No endpoint is named here on purpose — a URL copied into this file would be asserted long after it stopped being true, which is the failure this step exists to prevent. Use web search/extract to confirm the exact URL, transport, and auth scheme — don't answer from memory. If you have no web access or genuinely can't find it, **ask the user** for the endpoint URL and auth instead of guessing.
2. **Pick the home from what you found.** An MCP server → an entry in the plugin's `mcp.json` (`type: "streamable-http"` with the official `url` — use the `https://…` URL, **never** `ws://`/`wss://`). A plain REST/HTTP endpoint → a `.tool` with `type: http`. Use `type: inline` only when hand-authoring the individual HTTP calls.
3. **An OAuth-protected MCP server usually needs NOTHING beyond its `mcp.json` entry.** Write just those two and let the app probe the server: it discovers the sign-in provider (MCP authorization spec), registers itself, and surfaces a per-user sign-in on the Connect page. That is the `oauth-auto` case, and for it you must NOT declare `variables` or `headers`.

   Some providers do not support automatic registration (`oauth-manual` — HubSpot, Google; see the walkthrough below). Those DO need a sign-in variable holding the client id of an app the owner registers, and an admin pastes the client secret on the tool's page. You do not have to guess which kind you are facing: write the two lines, then run `list_tool_setup` and read `setup.kind` — and `setup.reason`, which spells out the next step (including the redirect URI to register).
4. **For key-based auth, wire it as `variables`, never a hard-coded secret.** Reference credentials as `${VAR}` in `headers` (e.g. `Authorization: Bearer ${NOTION_TOKEN}`) and declare each in the `variables` block with a scope (`admin` = one shared value; `user` = per-user). Users fill the values in the Secrets Vault.
5. **Say so when a tool is reachable ONLY from the user's own machine.** For an MCP server (e.g. one on `localhost`), declare `local: true` on its entry in the plugin.json extensions block — `remote: false` is a `.tool` frontmatter field and means nothing in `mcp.json`. For an `http`/`inline` `.tool`, set `remote: false`. Otherwise leave the tool remote-capable.

### Checking what an admin still needs to configure

Call the **`list_tool_setup`** tool to see, for every accessible tool — `.tool` manuals and `mcp.json` servers alike — what is configured and what is still missing. Use it whenever a tool isn't working, after adding a tool, or when asked "what do I need to set up?" — then EXPLAIN the remaining steps to the user rather than guessing. Per tool it reports:

- **`setup.kind`** (for MCP servers): `open` = no credentials needed; `oauth-auto` = the platform registered itself with the server automatically and users just authorize on the **Connect page**; `oauth-manual` = the sign-in uses an OAuth app the owner registers (the provider offers no automatic registration, or the declaration already names a client id). `setup.reason` is present only while something still blocks that sign-in — no declaration yet, or endpoints that could not be discovered — and says what to do.
- **Per variable**: `adminConfigured` (the shared value — or, for a sign-in, the owner-side provider setup — is done), `userConfigured` / `authorized` (the CURRENT user's own value / sign-in), and `canWrite` (whether the current user may set the tool's shared config).

**Tools are served from the default branch only.** An `mcp.json` entry or `.tool` you write on a draft is committed to that draft and nowhere else: it is not listed, not callable and has no sign-in on the Connect page until the draft is merged. After declaring a tool on a draft, call `list_tool_setup` with `branch` set to that draft — `onBranchOnly` names what is still waiting there — and tell the user it goes live once the change request is merged. A tool that stays in `tools` is released, and a restart does not remove it or its sign-ins; if one disappears, check the caller's read access to the file that declares it.

**A released tool or skill is live within five seconds — no reconnect.** A commit on the default branch that adds, changes or removes a `.tool`, an `mcp.json`, a `plugin.json` or a `SKILL.md` drops the catalogs at once, whichever way the commit arrived: the app, the file tools, a git push, or an approved change request being applied. The hosted endpoint is stateless — it reads the live catalog on every request, so the very next call sees the change. The local `hexis-mcp` server is TOLD: the workspace announces the change down a stream that server keeps open, and it re-registers what changed, local-only servers included. It also checks on its own whenever its connection is used — a tool call finishing, a client listing the tools — at most once every two seconds, which is what keeps it current against a workspace too old to announce anything. It asks nothing on a timer and nothing at all while idle, so an unused connection costs the workspace nothing. Within five seconds of the commit, `list_tools`, `list_tool_setup` and `list_local_tools` answer with the new state on the connection you already have, and the new tool is callable on it — whether or not anyone was using that connection when the commit landed, and unless a tool call is still running on it, which holds the refresh until it finishes (see the caveat below). Skills need no check at all: `list_skills` and `get_skill` read the workspace on every request, so a committed `SKILL.md` is in the very next answer, and the two resolve a skill the same way, so a skill you can load by name is a skill the listing shows.

The platform also sends the MCP tool-list-changed and prompt-list-changed notifications when it can. **A client that CACHES the list it got at connect time — rather than honouring those notifications — will not see the change: it must re-list, or reconnect.** That is a property of the client, not of the workspace; if a tool you just wrote is missing, call `list_tools` again before assuming anything is wrong. Two caveats on the local `hexis-mcp` server: a refresh there waits for a tool call that is still running (up to 15 seconds), so a commit made mid-call lands once that call finishes — and a LOCAL-only server (`local: true`, or a `type: "stdio"` command) that changed is restarted by that refresh, so a call to it made in the same moment may see it come back. And if the announcement stream cannot be held open at all — a workspace older than that server, or a proxy between them that will not carry an event stream — the five seconds becomes "at the connection's next use": the server says so once on stderr, and its own checks then carry the change instead.

The listing is scoped by the same access controls as everything else: a tool the caller can't READ doesn't appear at all, and `canWrite` means write access **on the file that declares it** — the `.tool` file itself (via its frontmatter `write:`/`owner:` verbs or the `access.md` chain), or the plugin's `mcp.json` for an MCP server (via the plugin's `access.md` chain — `mcp.json` carries no verb list of its own) — NOT any platform role. The people who manage that file are exactly the people who configure its shared secrets. To delegate a `.tool` to someone, add them to that file's `write:`/`owner:` list; to delegate an MCP server, grant them `write` on the plugin in its `access.md` (both are edits you can make via change request). That alone lets them configure it.

**Agents never handle secret VALUES.** Never ask for an API key, token, or client secret in the conversation, and there is no tool to set one. Point the right person at the right surface instead:

- **Shared (admin) values and OAuth client secrets** → a tool writer pastes them into the fields on the tool's page in the app (the "Your connection" section; for a `.tool` file, the setup panel is also in its editor sidebar).
- **Per-user values and sign-ins** → each user enters/authorizes on the **Connect page**.

For **`oauth-manual`** (e.g. HubSpot, Google, GitHub, Slack — no dynamic client registration), walk the admin through the one-time setup:

1. Register an OAuth app in the provider's console, with redirect URI `<backend>/api/secrets/oauth/callback` (the exact URI is in `setup.reason`).
2. Ask for the app's **client id** (public — fine to receive in chat) and write the sign-in declaration yourself: for an `mcp.json` server, the `variables` entry with `oauth: { clientId }` plus the `Authorization: Bearer ${VAR}` header in the plugin.json extensions entry (see "Declaring an OAuth sign-in" above — no URLs needed); for a `.tool`, the same entry with `authorizationUrl` and `tokenUrl` as well. You can do this edit for them via a change request. A human can do the same under "Edit server" on the tool's page — the form's fields are exactly this block.
3. Run `list_tool_setup` again: `setup.reason` must be gone. If it says the endpoints could not be discovered, add `authorizationUrl`/`tokenUrl` from the provider's docs.
4. The admin pastes the app's **client secret** into the "Client secret" field on the tool's page — never into the file, never into the chat.
5. Every user then authorizes on the Connect page.

## Conventions

These are conventions, not validations — nothing rejects a file for breaking
them. They exist because a knowledge base people can navigate beats one that is
merely correct.

1. **Descriptive file names.** `Weekly-Sync-2026-03-14.md` beats `notes3.md`.
   Avoid spaces; they survive git fine but make links noisier to read.

2. **Markdown links between documents.** Use
   `[Page Name](relative/path/to/Page.md)`, relative to the LINKING file's
   directory rather than the repo root, so links resolve both in the app and on
   the git host.

3. **Absolute dates.** `YYYY-MM-DD`, never "last Tuesday" — a saved file
   outlives the moment it was written.

4. **Search before creating.** If a document on the subject exists, extend it
   rather than starting a rival.

5. **Preserve what is there.** Append or edit sections; do not overwrite a file
   wholesale unless asked to.

6. **Say where it came from.** When a claim rests on a specific source — a
   person, a ticket, a document, a URL — name it inline near the claim, with
   the date it was true. The next reader's first question is "says who, and is
   it still true?".

## Finding things

- `grep` for keywords across `{{knowledgeBaseDir}}/`.
- Follow markdown links: when you read `[Some Page](relative/path/Some Page.md)`,
  that path is relative to the file you are reading.
- `list_files` to see the shape of a folder before assuming where something
  lives.
