# Company Knowledge graph

This is a git-backed knowledge graph. You are the primary agent responsible for maintaining it.

## Directory Structure

The repo holds multiple **ontologies** side-by-side under two roots — `KnowledgeBase/` (curated knowledge) and `Data/` (agent-produced records). Each ontology owns its own NodeType definitions and its own knowledge nodes:

```
knowledge-base/
├── KnowledgeBase/        ← all team ontologies live here
│   ├── <Ontology>/       ← one ontology (e.g. "Processes", "Product")
│   │   ├── NodeTypes/    ← node type definitions (do not modify without permission)
│   │   ├── Knowledge/    ← all knowledge nodes for this ontology
│   │   └── access.md     ← optional ontology-root access control
│   └── <AnotherOntology>/
│       ├── NodeTypes/
│       └── Knowledge/
├── Skills/               ← optional reusable agent skills (not part of the graph)
├── Tools/                ← optional tool manuals (*.tool files; not part of the graph)
├── Data/                 ← agent-produced records, parsed like KnowledgeBase/ (dashboards read here)
├── Agents/               ← .agent files — agent role configurations (format TBD)
├── Pipelines/            ← .pipeline files — processes the execution layer runs (format TBD)
├── roles.yaml            ← identity → role mapping (Admin-only edits)
└── access.md             ← repo-root access-control rules
```

Ontologies live as **direct subfolders of `KnowledgeBase/`** (curated knowledge) or of `Data/` (agent-produced records). Any folder there that contains BOTH a `NodeTypes/` subfolder and a `Knowledge/` subfolder is automatically picked up as an ontology by the Bevel platform's graph parser, validator, and access-control. `Data/` may also itself be a single ontology: when `Data/` directly contains both `NodeTypes/` and `Knowledge/`, the parser treats `Data/` itself as one ontology. Folders outside those two roots (such as `Skills/` and `Tools/`) are never treated as ontologies. To add a new ontology, create the two subfolders under `KnowledgeBase/` (or `Data/`).

### Agentic execution layer base folders (`Data/`, `Agents/`, `Pipelines/`)

Three base folders scaffold the agentic execution layer (design notes: the Bevel platform repo's `docs/agentic-execution-layer.md`):

- **`Data/`** — what agents produce and consume, split out of the curated `Knowledge/` folders: pipeline instances, work items/tickets, intermediate outputs. Dashboards and the fleet view read from here. **Parsed exactly like `KnowledgeBase/`** — its subfolders are self-contained ontologies (`NodeTypes/` + `Knowledge/`), so data records are real typed graph nodes. Instance nodes carry current state; full transcripts/logs stay plain files (no `nodeType:` frontmatter) so they never enter the graph payload.
- **`Agents/`** — `.agent` files: role definitions naming a target agent (e.g. Claude Code) and composing its configuration — skills, tools, model, permissions, hooks, identity and budget references. An `.agent` only **narrows** its identity's permissions, never widens them; secrets are referenced from the vault, never contained. MCP configs are minted per `.agent`.
- **`Pipelines/`** — `.pipeline` files: the processes the execution layer runs. Nodes are an `.agent` reference, a UTCP tool call, or a wait node; plus transitions, failure policy, and triggers.

The platform's parser scans `Data/` exactly like `KnowledgeBase/`: its subfolders that carry both `NodeTypes/` and `Knowledge/` are self-contained ontologies whose typed nodes are part of the graph — and `Data/` itself qualifies as a single ontology when it directly contains both folders. `Data/` paths are, however, exempt from the one-ontology-per-session boundary — pipeline agents read knowledge and write data records in the same session. The `.agent`/`.pipeline` file formats are still being designed. `Agents/` and `Pipelines/` are, like `Skills/` and `Tools/`, never parsed as ontologies. Each folder's `README.md` documents its structure and contents.

**Cross-ontology references are allowed.** A node in `Processes/Knowledge/...` may link to a node in `Product/Knowledge/...` (or vice versa) using a normal file-relative markdown link, e.g. `[Foo](../../Product/Knowledge/.../Foo.md)`. The parser resolves the link to a repo-root path and the validator checks the target exists across all ontologies.

### Creating a new ontology

To add a new ontology, create a folder under `KnowledgeBase/` (curated knowledge) or `Data/` (agent-produced records) with two subfolders — `NodeTypes/` and `Knowledge/` — and seed its `NodeTypes/NodeType.md`:

1. **Give the new ontology its own `NodeTypes/NodeType.md`.** Every ontology is **self-contained** and must carry its own copy of the meta `NodeType.md` (the type that defines all other NodeTypes). Do **not** point a new ontology's NodeTypes at another ontology's `NodeType.md` — and do not read another ontology to obtain the content. Copy the **canonical meta type below, verbatim**, into `<NewOntology>/NodeTypes/NodeType.md`. It is identical in every ontology, so it is reproduced here in full so you never have to reach into another ontology for it.

2. **Every NodeType definition file references the meta type as a sibling.** The meta `NodeType.md` itself and each concrete type you add (e.g. `NodeTypes/Meeting.md`) live **inside** the `NodeTypes/` folder, so they all declare:

   ```
   ---
   nodeType: "[NodeType](NodeType.md)"
   ---
   ```

   followed by the type's `# Name`, `# Description`, and one `# Field` header per field. Concrete NodeTypes differ from the meta type only in their fields — the `nodeType:` line is the same. Use the **sibling** path `NodeType.md` (the file is already in `NodeTypes/`), **not** `NodeTypes/NodeType.md` — from inside `NodeTypes/` that resolves to a non-existent `NodeTypes/NodeTypes/NodeType.md`.

#### Canonical meta `NodeType.md`

Copy the block below verbatim into every new ontology's `NodeTypes/NodeType.md` (the outer ````` ```` ````` fence is just the wrapper — copy the content between the fences):

````markdown
---
nodeType: "[NodeType](NodeType.md)"
---

# Name
The name of this node type. Must be PascalCase and unique across all node types.

# Description
A brief explanation of what this node type represents and when to use it.

# Fields
Define each field as a header in the node type file. Any header level (`#`, `##`, `###`, `####`, `#####`, `######`) can be used to represent a field or nested sub-field. The header hierarchy defines the structure of nodes of this type.

Headers are equivalent to field names in a YAML object, and the paragraph text beneath each header is the field's 'text' field value. The header hierarchy defines nesting, just as indentation does in YAML.

Each header should be followed by a description of what that field should contain. When a node of this type is created, the description is replaced with actual content.

## Field Parameters
A header may include parameters in parentheses at the end to describe its properties. Multiple parameters are comma-separated.

### optional
Marks the field as optional. Nodes of this type may omit it without triggering a validation error.

Example: `# Notes (optional)`

### link
Declares how markdown links found under this heading (and any of its sub-headings) are categorised on the parsed node. The syntax is `link <category>`, where `<category>` is a free-form name such as `outbound`, `inbound`, `child`, `parent`, or `value_slice`.

Example: `# Created Output (link outbound)` — all links under this heading are stored in the node's `links["outbound"]` list.

Parameters can be combined: `# Parent (optional, link parent)`.

Links found under headings without an explicit `link` parameter default to `outbound`.

### folder-parent
Marks the field that determines this node's **placement** on disk — where its `.md` file is filed. One field per type drives placement (the first one tagged). It works in two modes, depending on whether the field it sits on is a link:

- **On a `link` field** → the node is filed as a **child of the linked node**, inheriting that parent's path (the child-node folder convention described in `CLAUDE.md`). Example: `# Home (link architecture, folder-parent)` — the node nests under the architecture node it links to.
- **On a plain-text field** (no `link`) → the node is filed in a **subfolder named after the field's value** (its first line), appended onto the ontology's base path. Example — a nested sub-field: `## Class (folder-parent)` where a node sets `Class: product` files that node under a `product/` folder.

This is what bulk node uploads use to place each node; when a type has no `folder-parent` field, the node is placed at the explicitly supplied path instead.

# Format Rules
Every node file that uses this type must:
- Start with a YAML frontmatter block declaring the node type, fenced by `---` lines, where the value is a quoted markdown link:
  ```
  ---
  nodeType: "[TypeName](NodeTypes/TypeName.md)"
  ---
  ```
  The value is quoted so the markdown link remains a valid YAML string.
- Use headers at any level to match the field structure defined in the node type
- Use `[Name](relative/path/to/Name.md)` markdown links when referencing other nodes in the knowledge graph

## Source of Information
Any heading in a node may additionally carry a **Source of Information** block — provenance recording *which sources* validate the heading's content, *what* each validates, and *when*. It is a collapsible `<details>` element whose `<summary>` reads "Source of Information", placed under the heading's content. It is metadata, **not a field**: never declare it as a `#` header, and never list it among a node type's fields.

The body is an **ordered list**; each item is `SOURCE — what it validates (YYYY-MM-DD)` — a source (a person `Name <email>`, a data artifact, a document, or a URL), what that source validates, and the validation date. At least one item is required; list several when different sources back different parts of the heading. The parser strips the block from the heading's text and links (so a URL or person reference never becomes a graph edge); the Bevel platform's validator checks each item is well-formed and computes tier ranking downstream. Example:

```
<details><summary>Source of Information</summary>

1. some-export.csv — ID, Name and Definition (2026-06-05)
2. Jane Doe <jane.doe@example.com> — the Definition wording (2026-06-03)

</details>
```
````

## Access control

Write access to any path is governed by `roles.yaml` (who has which role) and `access.md` files (which roles/users can write where). The access-control resolver + validation live in the Bevel platform, which checks both files for syntax, role references, and the rule that at least one Admin must exist when access is resolved.

- **Roles** in `roles.yaml` map a role name to a list of emails. Role names are case- and whitespace-insensitive (`Admin` = `admin` = `ADMIN`; `Product Team` = `product team`). The reserved name `deny` cannot be used.
- **Access rules** live in `access.md` files. Each declares a `write:` list whose entries are either grants (bare principal — a role name or `Name <email>`) or denials (lowercase `deny ` prefix + principal). Capitalised forms like `Deny` are *not* triggers; they're treated as part of a name.
- **Resolution** walks repo root → file directory, accumulating per-principal state. User-level entries trump role-level entries. A role denial removes only that role's contribution; it does not undo grants from other roles.
- **`roles.yaml` is editable only by Admin** — hard-coded in the resolver, never overridable by an `access.md`.
- **`access.md` files are picked up everywhere inside an ontology** (repo root, ontology root such as `Processes/access.md`, and any depth inside `<ontology>/Knowledge/...`).

Access rules are enforced at runtime by the Bevel platform's access-control service; a malformed `roles.yaml` or `access.md` surfaces there when access is resolved.

### Direct writes vs change requests

File-level write access decides how a change lands on the default branch:

- A user — or an agent acting as that user — whose access resolution grants **write or owner on every file the change touches** may commit **directly** to the default branch.
- Without that access, the change goes through a **branch + change request**, approved by an owner / write-access holder of the affected files.
- Agents carry exactly their user's access, never more. Before writing to the default branch, **ask the user** whether to write directly or go through the review flow — and prefer a change request when in doubt, when the change is large, or when it touches content the user doesn't own.

### Child node folder convention

When a node has child nodes (any field with `link child` type) that each warrant their own node file, group them in a subfolder named identically to the parent node (without the `.md` extension). The parent node file sits **next to** its subfolder, not inside it.

Example: a node `Knowledge/Foo.md` with two children lives like this:

```
Knowledge/
├── Foo.md             ← parent node
└── Foo/
    ├── Bar.md         ← child of Foo
    └── Baz.md         ← child of Foo
```

If any of those children themselves have children, create another identically-named subfolder one level deeper:

```
Knowledge/
├── Foo.md
└── Foo/
    ├── Bar.md
    ├── Bar/
    │   └── Sub-Bar.md
    └── Baz.md
```

All links in node files use **file-relative paths**, e.g. a file at `Knowledge/Foo.md` links to its child as `[Bar](Foo/Bar.md)`. Cross-ontology links walk up to the repo root and back down into the other ontology, e.g. from `Processes/Knowledge/Process Groups/Group/Foo.md` to `Product/Knowledge/Bar.md` use `[Bar](../../../../Product/Knowledge/Bar.md)`.

## Tool Manuals (`Tools/`)

`Tools/` holds `*.tool` files — reusable **tool manuals** that let agents call external APIs. They are **not part of the knowledge graph** (never modelled as nodes) and are access-controlled like any other file via `access.md`. Any user who can *read* a `.tool` can use its tools; anyone who can *write* it sets its shared (admin) secrets (see below). Put each manual directly under `Tools/` (subfolders are allowed for grouping).

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

**Remote vs local (`remote`).** A tool is available to remote agents by default. Add `remote: false` for a tool that only works on the user's own machine (e.g. an mcp/http `url` on `localhost`): the hosted remote MCP endpoint then skips it and instead advertises it through the `list_local_tools` tool, which returns the `.tool`'s path so a local agent can read it and self-configure (e.g. add the MCP server to its own client).

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

1. **Find the real endpoint from the vendor's own docs.** Prefer the vendor's official **remote MCP server** if one exists (e.g. Notion's is `https://mcp.notion.com/mcp`); otherwise fall back to their **REST API** base. Use web search/extract to confirm the exact URL, transport, and auth scheme — don't answer from memory. If you have no web access or genuinely can't find it, **ask the user** for the endpoint URL and auth instead of guessing.
2. **Pick the type from what you found.** An MCP server → `type: mcp` with the official `url` (the MCP transport is HTTP/streamable — use the `https://…` URL, **never** `ws://`/`wss://`). A plain REST/HTTP endpoint → `type: http`. Use `type: inline` only when hand-authoring the individual HTTP calls.
3. **An OAuth-protected MCP server needs NOTHING beyond `type: mcp` + `url`.** The app probes the server, discovers its sign-in provider (MCP authorization spec), registers itself automatically, and surfaces a per-user sign-in on the Connect page — do NOT declare `variables` or `headers` for it. Only add them for servers that use plain API keys or don't follow the spec.
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

## Node Format

Read the meta type: `<ontology>/NodeTypes/NodeType.md` (every ontology has its own copy — they're identical in form).

A markdown file is treated as a **knowledge node** only when it opens with a YAML frontmatter block (fenced by `---`) that declares a `nodeType:`. Files without that frontmatter (free-form notes, scratch docs, READMEs, etc.) are ignored by the parser — they are not validated, not added to the graph, and not surfaced in the diagram. Use this when you want a markdown file in `Knowledge/` that isn't itself a typed node.

The frontmatter looks like this (the value is a quoted markdown link so it stays a valid YAML string):

```
---
nodeType: "[Process](../../NodeTypes/Process.md)"
---
```

A node's `nodeType:` link points to a NodeType definition file. The link target is the source of truth: a node in `Processes/Knowledge/Process Groups/Foo.md` with `nodeType: "[Process](../../NodeTypes/Process.md)"` is bound to the `Process` type defined in `Processes/NodeTypes/Process.md`. Two ontologies may both define a type called `Process` without colliding — each ontology's nodes resolve to that ontology's definition.

### Source of Information (per-heading `<details>` blocks)

The provenance of a heading — *which sources* validate its content, *what* each validates, and *when* — is tracked **per heading** in a collapsible HTML `<details>` block whose `<summary>` reads "Source of Information", placed under the heading's content.

The body is an **ordered list**. Each item names a source, what that source validates, and the validation date in parentheses:

```markdown
# Goal
To manage the buyer's shopping cart lifecycle…

<details><summary>Source of Information</summary>

1. Jane Doe <jane.doe@example.com> — the goal and end-to-end flow (2026-06-03)
2. PROC-1234 — Basket optimisation & awarding rework — the awarding step (2026-05-12)

</details>
```

Each item is `SOURCE — what it validates (YYYY-MM-DD)`:
- **SOURCE** — free text identifying the source: a person (`Name <email>`), a data artifact (e.g. `some-export.csv` or a ticket key), a document, or a URL.
- **what it validates** — which part of the heading's content that source backs.
- **(YYYY-MM-DD)** — the date that source last validated it.

The separator is an em dash `—` (a plain hyphen `-` is also accepted). At least one item is required; list several items when different sources back different parts of the heading.

**Binding data sources.** A non-human source that is *ground truth* because it is backed by a binding artifact — a signed contract, code on the deployed main branch, an executed order — is marked by making **`Binding` the first word of the SOURCE**, followed by the URL/reference:

```markdown
1. Binding https://github.com/acme/app/commit/abc123 — the deployed payment flow (2026-06-01)
2. Binding [Signed MSA](https://drive.example/msa.pdf) — the contracted SLA (2026-05-20)
```

A binding source is graded higher than a plain external data source (it isn't flagged for revalidation on its own), but lower than a human with write access. The marker is the literal word `Binding` (case-insensitive) at the start; without it, the same URL is treated as an ordinary data source.

The block is parsed onto the heading's `field.sourceOfInformation` (an array of `{ source, validates, date, tier }`, where `tier` is the source's validation tier — `binding-data` / `data-source` graded from the text, refined to `owner` / `writer` / `none` for human sources when the graph is built with access resolution) and **stripped** from the field's text and graph links, so a URL or person reference never becomes an edge. It is exposed via `toDict()` for downstream consumers.

This repo is **data only** — parsing, format-checking, and tier ranking all happen in the **Bevel platform**. The backend validator (the `validate_graph` tool) **errors** on a malformed item: a line that isn't `SOURCE — what it validates (YYYY-MM-DD)`, a missing source or missing "what it validates", or an invalid date. A heading with **no** block is fine.

When you create or substantially change a heading's content, add or refresh its `Source of Information` block.

## Critical Rules

1. **Before creating any typed node, read the NodeType first.** Check `<ontology>/NodeTypes/<Type>.md` for the exact field names and structure. Never invent fields. (Plain markdown files without a `nodeType:` frontmatter declaration don't need this — they aren't nodes.)

2. **File naming:** Use descriptive names in `PascalCase-With-Hyphens`. No spaces. Examples:
   - `Knowledge/Weekly-Sync-2026-03-14.md`
   - `Knowledge/Jane-Doe.md`
   - `Knowledge/Our-Company.md`

3. **Markdown links everywhere.** Use `[PageName](relative/path/to/PageName.md)` whenever referencing another node. Paths are **relative to the linking file's directory** (not the repo root). This ensures links work correctly on GitHub. This is what builds the knowledge graph.

4. **Dates:** Always `YYYY-MM-DD`. Never relative dates in saved files.

5. **No duplicates.** Search before creating. If a node exists, update it.

6. **Preserve existing content.** Append or edit sections — never overwrite a file wholesale unless explicitly asked.

7. **Folder structure follows hierarchy, not node type.** Use the subprocess folder convention (described above) when grouping subprocesses under a parent. Never create subfolders for arbitrary organisational purposes — only to mirror a process hierarchy. Node types are always determined by reading `nodeType:` at the top of each file, not by folder location.

## Graph Integrity

The knowledge graph's value comes from bidirectional links between processes. Every data flow must be declared on **both sides**:

1. **Outputs must link to consumers.** Under `# Created Output`, each `## Output Name` section must contain a markdown link to every process that consumes this output.

2. **Inputs must link to producers.** Under `# Needed Input`, each `## Input Name` section must contain a markdown link to the process that provides this input.

3. **Output and input headings must match.** When process A produces "Foo" consumed by process B, the `## Foo` heading should appear under A's `# Created Output` (linking to B) **and** under B's `# Needed Input` (linking to A). The heading text should be the same on both sides.

4. **When adding or modifying a link, always update both sides.** If you add an output link from A→B, also add or update the corresponding input section in B. If you rename an output, update the matching input heading in all consumers.

5. **When moving or renaming a file, update all references.** Search for the old path across every ontology's `Knowledge/` directory and update every link.

## After Every Change

Graph parsing, validation, and visualisation live in the **Bevel platform**, not in
this repo. This repo is **data** — node `.md` files. There are no local build or
validation scripts to run here.

Validation runs automatically inside the app: every save/commit is validated
in-process, and an agent can validate a branch on demand via the `validate_graph`
tool. It reports the same integrity issues you must fix:

| Issue | Must fix? | Meaning | Fix |
|---|---|---|---|
| `DANGLING LINK` | **Yes** | An id-link points to an id no node has | Fix the id or create the missing node |
| `ASYMMETRY` | **Yes** | One side of a data flow links to the other, but not vice versa | Add the missing link on the other side |
| missing / duplicate / malformed `id` | **Yes** | Every node needs a unique lowercase-kebab frontmatter `id:` | Add/fix the `id:` |
| malformed Source of Information | **Yes** | A `<details>` block item isn't `SOURCE — what it validates (YYYY-MM-DD)` | Fix the item |

The process diagram is produced as a dynamically-generated HTML view from the
backend graph — there is no committed `diagram.md` to regenerate.

## How to Query

- Find nodes by type across all ontologies: `Grep` for `nodeType:.*TypeName` recursively
- Find by content: `Grep` across each ontology's `Knowledge/` for keywords
- Follow links: when you see `[SomePage](relative/path/SomePage.md)`, read that file (paths are file-relative; cross-ontology references walk via `../` to the repo root)

## Handling Unknown Types

If information doesn't fit any existing NodeType, ask the user whether to:
- Create a new NodeType (you can do this by creating a new file in the relevant `<ontology>/NodeTypes/` folder, following the meta `NodeType.md` format)
- Fit it into the closest existing type with a note

## NodeType definitions are auto-discovered

The Bevel platform's graph parser derives each NodeType's shape **at runtime** from its definition in any `<ontology>/NodeTypes/*.md` file — every `# Field` header becomes part of the node's schema (link fields, sub-header child maps, plain text).

**There is nothing to hand-maintain when you add/remove/rename NodeType fields.** Just edit the `<ontology>/NodeTypes/<Type>.md` file; the parser picks up the new shape on the next run. If you add a new NodeType file, add it under the right ontology's `NodeTypes/` folder.
