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
├── Groups/               ← one folder per group: its skills AND its tools
├── roles.yaml            ← identity → role mapping (Admin-only edits)
└── access.md             ← repo-root access-control rules
```

Only those two folders are structural, and only `Groups/` has a layout the
platform reads:

```text
Groups/<Group>/<skill>/SKILL.md   a skill
Groups/<Group>/<name>.tool        a tool manual
Groups/<Group>/access.md          who can read/write the whole group
Groups/personal-<user-id>/…       one per person: their own skills, private
```

Skills and tools live TOGETHER in a group because they share one access
boundary: a tool a group cannot read is a skill that group cannot run.

**Group folders are made through the app, not by writing files.** A group
exists exactly when its folder carries an `access.md` — a bare directory
under `Groups/` is not a group and is never listed. A new
direct child of `Groups/` needs an `access.md` naming who runs it, and the
write gate refuses a plain write into an unused name there — so do not try to
create a group by writing a skill into `Groups/<new-name>/…`; it will be
denied. Send the user to the app's **New group** button (or its
`POST /api/groups` endpoint), then write into the folder it made. Names
starting with `personal-` are reserved: one such folder exists per person,
created automatically with their first personal skill, readable only by its
owner and never listed as a group — a signed-in user's own skills belong
there, and move into a group by moving the skill's folder.

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
  = `product team`). The reserved name `deny` cannot be used.
- **Access rules** live in `access.md` files. Each declares a `write:` list
  whose entries are either grants (bare principal — a role name or
  `Name <email>`) or denials (the lowercase word `deny`, a space, then the
  principal). Capitalised forms like `Deny` are *not* triggers; they are
  treated as part of a name.
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

## Skills (`Groups/<Group>/<skill>/SKILL.md`)

A skill is a folder holding a `SKILL.md` and whatever files it needs. The
frontmatter names it and declares which tools it may use:

```yaml
---
name: weekly-newsletter
description: Drafts the Friday newsletter for review.
allowed-tools: [slack_post_message]
---
```

The body is the instructions, in plain markdown. `allowed-tools` entries are
tool names from the `.tool` manuals in the same group — a skill can only reach
tools its group can read.

## Tool Manuals (`Groups/<Group>/*.tool`)

Each group folder holds `*.tool` files — reusable **tool manuals** that let agents call external APIs. They are **not part of the knowledge graph** (never modelled as nodes) and are access-controlled like any other file via `access.md`. Any user who can *read* a `.tool` can use its tools; anyone who can *write* it sets its shared (admin) secrets (see below). Put each manual directly in the group folder whose skills use it. The same
integration may exist in several groups as separate files (`Everyone/notion.tool`
and `Finance/notion.tool`), each with its own credentials and access rule —
a group is a folder, not a registry of unique names.

A `.tool` file is JSON or YAML. Its `type` decides how tools are discovered:

- **`inline`** — the tools are embedded in the file (no network round-trip to list them).
- **`http`** — `url` points to an endpoint that returns a UTCP manual.
- **`mcp`** — `url` is a remote MCP server whose tools are discovered over MCP.

**The tool is the frontmatter.** A `.tool` is one `---` YAML block holding *everything* — its `id`, its access verbs (`read:`/`write:`/`owner:`/`download:`), and its config (`type`/`url`/`variables`/…) — all in the same object. Anything after the closing `---` is free-form notes the parser ignores (like a `SKILL.md` body):

```yaml
---
id: my_tool
write:
  - Product Team
owner:
  - Jane Doe <jane@x.com>
type: mcp
url: https://mcp.example.com
---
```

(A file with no `---` fence is the legacy form — the whole file is the object, so a bare JSON `.tool` still works.)

**`id` = variable namespace.** The `id` is the manual's stable identity: it's the UTCP namespace secrets bind to (`<id>_<VAR>`) and its route slug. It must be lowercase `snake_case` and **unique** across all `.tool` files. Resolution is `id` → `name` → the file name (so a `name:` alone works, same as the id system uses for every file). If two files collide, the one saved most recently through the app is auto-suffixed (`my_tool` → `my_tool2`). **Access** declared here gates who can use and edit that tool, exactly like a node's own frontmatter (most specific; overrides the folder `access.md`).

**Frontmatter `id` = address.** This is generic, not tool-specific: ANY `.md` or `.tool` file whose frontmatter declares an `id` (or a lowercase snake_case/kebab `name`) is addressable at `/workspace/<branch>/<id>` in the app, exactly like a knowledge node — tools, skills (`SKILL.md`), and plain notes alike. Graph nodes win an id collision; files without frontmatter stay path-addressed.

**Remote vs local (`remote`).** A tool is available to remote agents by default. Add `remote: false` for a tool that only works on the user's own machine (e.g. an mcp/http `url` on `localhost`): the hosted remote MCP endpoint cannot reach it, so it skips the tool and advertises it through the `list_local_tools` tool instead.

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
2. **Pick the type from what you found.** An MCP server → `type: mcp` with the official `url` (the MCP transport is HTTP/streamable — use the `https://…` URL, **never** `ws://`/`wss://`). A plain REST/HTTP endpoint → `type: http`. Use `type: inline` only when hand-authoring the individual HTTP calls.
3. **An OAuth-protected MCP server usually needs NOTHING beyond `type: mcp` + `url`.** Write just those two and let the app probe the server: it discovers the sign-in provider (MCP authorization spec), registers itself, and surfaces a per-user sign-in on the Connect page. That is the `oauth-auto` case, and for it you must NOT declare `variables` or `headers`.

   Some providers do not support automatic registration (`oauth-manual` — see the walkthrough below). Those DO need a sign-in variable to hold the client id, and an admin pastes the client secret on the tool's page. You do not have to guess which kind you are facing: write the two lines, then run `list_tool_setup` and read `setup.kind`.
4. **For key-based auth, wire it as `variables`, never a hard-coded secret.** Reference credentials as `${VAR}` in `headers` (e.g. `Authorization: Bearer ${NOTION_TOKEN}`) and declare each in the `variables` block with a scope (`admin` = one shared value; `user` = per-user). Users fill the values in the Secrets Vault.
5. **Set `remote: false`** only when the tool is reachable ONLY from the user's own machine (e.g. a `localhost` MCP server); otherwise leave it remote-capable.

### Checking what an admin still needs to configure

Call the **`list_tool_setup`** tool to see, for every accessible `.tool`, what is configured and what is still missing. Use it whenever a tool isn't working, after adding a tool, or when asked "what do I need to set up?" — then EXPLAIN the remaining steps to the user rather than guessing. Per tool it reports:

- **`setup.kind`** (for `type: mcp`): `open` = no credentials needed; `oauth-auto` = the platform registered itself with the server automatically and users just authorize on the **Connect page**; `oauth-manual` = the provider does not support automatic registration, so a tool writer must configure it by hand (below).
- **Per variable**: `adminConfigured` (the shared value — or, for a sign-in, the owner-side provider setup — is done), `userConfigured` / `authorized` (the CURRENT user's own value / sign-in), and `canWrite` (whether the current user may set the tool's shared config).

The listing is scoped by the same access controls as everything else: a `.tool` the caller can't READ doesn't appear at all, and `canWrite` means write access **on that `.tool` file itself** — granted by its frontmatter `write:`/`owner:` verbs or the `access.md` chain, NOT by any platform role. The people who manage a `.tool` file are exactly the people who configure its shared secrets. To delegate a tool to someone, add them to the file's `write:` or `owner:` list (an edit you can make via change request); that alone lets them configure it.

**Agents never handle secret VALUES.** Never ask for an API key, token, or client secret in the conversation, and there is no tool to set one. Point the right person at the right surface instead:

- **Shared (admin) values and OAuth client secrets** → a tool writer pastes them into the fields on the tool's page in the app (open the `.tool` file; the setup panel is in its sidebar).
- **Per-user values and sign-ins** → each user enters/authorizes on the **Connect page**.

For **`oauth-manual`** (e.g. Google, GitHub, Slack — no dynamic client registration), walk the admin through the one-time setup:

1. Register an OAuth app in the provider's console, with redirect URI `<backend>/api/secrets/oauth/callback`.
2. Put the app's **client id** (public) in the `.tool` file's sign-in variable — you can do this edit for them via a change request.
3. The admin pastes the app's **client secret** into the "Client secret" field on the tool's page — never into the file, never into the chat.
4. Every user then authorizes on the Connect page.

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
