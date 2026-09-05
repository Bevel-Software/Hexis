# Knowledge base

This is a git-backed knowledge base. You are the primary agent responsible for
maintaining it.

> **This file is managed by the platform.** Every server restart replaces it
> with the current template, so edits made here are overwritten. Deployment- or
> team-specific conventions belong in files of your own — anywhere under
> `KnowledgeBase/`, linked from wherever they are needed.

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
├── KnowledgeBase/        ← the knowledge itself; organise it however suits you
├── Skills/               ← shared skills, organised by who owns them
├── Plugins/              ← one folder per plugin: its tools, and links to skills
├── roles.yaml            ← identity → role mapping (Admin-only edits)
└── access.md             ← repo-root access-control rules
```

(A deployment may have renamed these three roots in its setup screen; the
names above are the defaults. `list_files` at the workspace root shows the
real ones.)

Tool paths are workspace-relative, and the workspace root holds this
repository as the `knowledge-base/` folder: a file in it is
`knowledge-base/KnowledgeBase/Foo.md`, never `KnowledgeBase/Foo.md`. A path
without that prefix is refused, because it would land beside the repository
where git never sees it.

Only those three folders are structural. `Skills/` holds shared skills at any
depth — the folder that holds a `SKILL.md` is the skill, and everything above
it is ownership (`Skills/<scope>/…/<skill>/SKILL.md`, with an `access.md` in
any scope folder that needs its own rules). `Plugins/` has a layout the
platform reads:

```text
Plugins/<Plugin>/plugin.json                  the manifest (Agent Plugins) — what makes the folder a plugin
Plugins/<Plugin>/skills/<skill>/SKILL.md      a skill that lives inside the plugin
Plugins/<Plugin>/mcp.json                     MCP servers (authoritative)
Plugins/<Plugin>/software.bevel.hexis/tools/  `.tool` manuals
Plugins/<Plugin>/access.md                    who can read/write the plugin
Plugins/personal-<user-id>/…                  one per person: private
```

**A plugin LINKS shared skills rather than containing them.** Its manifest
lists skill paths under `extensions["software.bevel.hexis"].skills` — each
entry is one skill folder or a folder of skills under `Skills/`:

```json
{ "extensions": { "software.bevel.hexis": { "skills": ["Skills/Engineering/deploy", "Skills/Sales"] } } }
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

**Symlinks are not supported anywhere under `Plugins/`.** Access control
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

**Plugin folders are made through the app, not by writing files.** A folder
is a plugin exactly when it carries a `plugin.json` (the platform writes one
into every legacy plugin folder at startup), and it is LISTED only when it
also carries an `access.md` — a bare directory under `Plugins/` is neither.
Plugins may sit at any depth under `Plugins/`; a folder that holds plugins
deeper down is a grouping folder, not a plugin. A new plugin needs an
`access.md` naming who runs it, and the write gate refuses a plain write
into an unused name there — so do not try to create a plugin by writing a
skill into `Plugins/<new-name>/…`; it will be denied. Send the user to the app's **New plugin** button (or its
`POST /api/plugins` endpoint), then write into the folder it made. Names
starting with `personal-` are reserved: one such folder exists per person,
created automatically with their first personal skill, readable only by its
owner and never listed as a plugin — a signed-in user's own skills belong
there, and move into a plugin by moving the skill's folder.

Everything under `KnowledgeBase/` is yours to arrange. Subfolders, naming,
whether a topic is one file or twenty — all of it is a judgement call about
what the next reader needs, not a rule the platform enforces.

A deployment may reserve further root folders of its own — `Data/`, `Agents/`
and `Pipelines/` scaffold an agentic execution layer in some installations.
They are not part of this template and are not created here; where they exist,
each carries its own `README.md` describing what belongs in it.

## Access control

Write access to any path is governed by `roles.yaml` (who has which role) and
`access.md` files (which roles/users can write where).

- **Roles** in `roles.yaml` map a role name to a list of emails. Role names are
  case- and whitespace-insensitive (`Admin` = `admin` = `ADMIN`; `Product Team`
  = `product team`). The reserved name `deny` cannot be used, and neither can
  names starting with `role/` or `plugin/` — those spellings are tokens in
  access entries (below).
- **Plugins are grantable principals.** `plugin/<Name>/read`,
  `plugin/<Name>/write` and `plugin/<Name>/owner` in any access file mean
  everyone who currently holds that verb on the plugin `<Name>`, derived live
  from the plugin's own `access.md`. This is how a shared skill is made
  visible to a plugin's members: `read: plugin/GTM/read` on the skill's folder.
  Adding or removing someone on the plugin changes what they can read
  everywhere the token is granted, with no copying.
- **Access rules** live in `access.md` files, which carry **two blocks with two
  scopes**: the body declares the rules for the folder the file sits in, and the
  frontmatter declares who may read and write that `access.md` itself. Each
  block names verbs (`read`, `write`, `download`, `owner`) whose entries are
  either grants (bare principal — a role name or `Name <email>`) or denials
  (the lowercase word `deny`, a space, then the principal). Capitalised forms
  like `Deny` are *not* triggers; they are treated as part of a name.
- **Keep an `access.md` body pure YAML**, with any explanation in `#` comments.
  A body that does not parse as YAML naming at least one verb is read in the
  older format instead, where the FRONTMATTER carried the folder's rules — so a
  stray line of prose silently changes which block governs the folder.
- **Resolution** walks repo root → file directory, accumulating per-principal
  state. User-level entries trump role-level entries. A role denial removes
  only that role's contribution; it does not undo grants from other roles.
- **`roles.yaml` is editable only by Admin** — hard-coded in the resolver,
  never overridable by an `access.md`.
- **`access.md` files are picked up at any depth**, so a folder can tighten or
  widen what it inherited from its parent.

Rules are enforced at runtime; a malformed `roles.yaml` or `access.md` surfaces
when access is resolved.

### Direct writes vs change requests

File-level write access decides how a change lands on the default branch:

- A user — or an agent acting as that user — whose access resolution grants
  **write or owner on every file the change touches** may commit **directly**
  to the default branch.
- Without that access, the change goes through a **branch + change request**,
  approved by an owner / write-access holder of the affected files.
- Agents carry exactly their user's access, never more. Before writing to the
  default branch, **ask the user** whether to write directly or go through the
  review flow — and prefer a change request when in doubt, when the change is
  large, or when it touches content the user does not own.

## Skills (`Skills/<scope>/…/<skill>/SKILL.md`, or `Plugins/<Plugin>/skills/<skill>/SKILL.md`)

A skill is a folder holding a `SKILL.md` and whatever files it needs. Shared
skills live under `Skills/`, organised by ownership; a skill that belongs to
exactly one plugin may live inside that plugin's `skills/` folder instead.
Skill names are unique across the whole catalog, whichever home they have.
The frontmatter names it, declares which tools it may use, and may carry a
governance record:

```yaml
---
name: weekly-newsletter
description: Drafts the Friday newsletter for review.
allowed-tools: [slack_post_message]
metadata:
  version: "1.4.0"
  owner: "GTM"
  lifecycle: active
---
```

The body is the instructions, in plain markdown. `allowed-tools` entries are
tool names from the `.tool` manuals and MCP servers of the plugins that hold
the skill. `metadata.version` is semver; `metadata.lifecycle` is `active`,
`deprecated` (still served, flagged in the library) or `retired` (kept for
its owners, never distributed to agents).

**How skills reach agents.** Through the MCP server (`list_skills`,
`get_skill`), or as native plugins: every user can clone a git remote from
the app's external-agent page that holds a plugin marketplace compiled from
exactly the skills they may read — one plugin per plugin here, a
`skills-and-knowledge` plugin for the rest plus this knowledge base's MCP
server, and a `hexis-all` bundle that installs everything.

## Tool Manuals (`Plugins/<Plugin>/software.bevel.hexis/tools/*.tool`)

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

- `grep` for keywords across `KnowledgeBase/`.
- Follow markdown links: when you read `[Some Page](relative/path/Some Page.md)`,
  that path is relative to the file you are reading.
- `list_files` to see the shape of a folder before assuming where something
  lives.
