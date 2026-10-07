## Tool Manuals (`{{pluginsDir}}/<Plugin>/software.bevel.hexis/tools/*.tool`)

Each plugin folder holds `*.tool` files — reusable **tool manuals** that let agents call external APIs. They are **not part of the knowledge graph** (never modelled as nodes) and are access-controlled like any other file via `access.md`. Any user who can *read* a `.tool` can use its tools; anyone who can *write* it sets its shared (admin) secrets (see below). Put each manual in the plugin's `software.bevel.hexis/tools/` directory, beside
the skills that use it. The same integration may exist in several plugins as
separate files (`Everyone/…/serper.tool` and `Finance/…/serper.tool`), each
with its own credentials and access rule — a plugin is a folder, not a registry
of unique names. The manual's **id** is, though: two files that resolve to
the same id (an explicit `id`, else `name`, else the file name) collide and
the second is refused, so give each copy its own `id` (`serper_everyone`,
`serper_finance`). Remember: `.tool` files are for `http` and `inline` manuals
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

**`id` = variable namespace.** The `id` is the manual's stable identity: it's the UTCP namespace secrets bind to (`<id>_<VAR>`) and its route slug. It must be lowercase `snake_case` and **unique** across all `.tool` files. Resolution is `id` → `name` → the file name (so a `name:` alone works, same as the id system uses for every file). If two files collide, the second is REFUSED, not renamed: a suffix would silently bind a configured secret to a different file, so the catalog keeps one and names the other as a duplicate until it is renamed by hand. **Access** declared here gates who can use and edit that tool, exactly like a node's own frontmatter (most specific; overrides the folder `access.md`).

**Frontmatter `id` = address.** This is generic, not tool-specific: ANY `.md` or `.tool` file whose frontmatter declares an `id` (or a lowercase snake_case/kebab `name`) is addressable at `/workspace/<branch>/<id>` in the app, exactly like a knowledge node — tools, skills (`SKILL.md`), and plain notes alike. Graph nodes win an id collision; files without frontmatter stay path-addressed.

**Remote vs local (`remote`).** A tool is available to remote agents by default. Add `remote: false` for a tool that only works on the user's own machine (e.g. an `http` manual whose `url` is on `localhost`): the hosted remote MCP endpoint cannot reach it, so it skips the tool and advertises it through the `list_local_tools` tool instead. (An MCP server that is local-only declares `local: true` in the plugin.json extensions block instead — see above.)

To actually USE those tools, run the workspace as a local MCP server:

```
npx @bevel-software/hexis-mcp --url <workspace-url> --key <connection-key>
```

It serves everything the hosted endpoint serves **plus** the local-only tools, because it runs on the machine where they exist. Remote tools still execute on the server, so their shared keys and OAuth sign-ins keep working untouched; a local-only tool's own `${VAR}`s are fetched by `hexis-mcp` from this workspace's Secrets Vault with the connection key, and from the environment of whatever launched the command (your MCP client's config) for any the vault does not hold. Reading the `.tool` and wiring the server into your client by hand still works and is the fallback when the command is unavailable.

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

### Calling a Google API as a service account: `auth_type: google_service_account`

Some Google APIs (Google Ads, Tag Manager, BigQuery, Sheets, …) are called as a **service account**: one shared identity, no sign-in per person. Google does not accept the service account's key on a call. It accepts a short-lived token that has to be minted from the key, so a header holding `${VAR}` cannot do it. Name the key in an `auth` block on an inline tool's `tool_call_template` instead, and the platform mints the token at call time, keeps it until shortly before it expires, and sends it as `Authorization: Bearer <token>`:

```yaml
---
id: google_ads
type: inline
variables:
  - { name: GOOGLE_SA_KEY,   scope: admin, label: "Service-account key JSON" }
  - { name: DEVELOPER_TOKEN, scope: admin, label: "Google Ads developer token" }
tools:
  - name: list_accessible_customers
    description: List the Google Ads customers the service account can reach.
    inputs: { type: object, properties: {} }
    outputs: { type: object, properties: {} }
    tool_call_template:
      call_template_type: http
      http_method: GET
      url: https://googleads.googleapis.com/v22/customers:listAccessibleCustomers
      headers: { developer-token: "${DEVELOPER_TOKEN}" }
      auth:
        auth_type: google_service_account
        credentials: ${GOOGLE_SA_KEY}
        scopes: https://www.googleapis.com/auth/adwords
---
```

| field | requirement | notes |
|---|---|---|
| `credentials` | required | always a `${VAR}`: the vault variable holding the key JSON Google issued for the service account (the whole file, or the file in base64). Admin-scoped, so a writer of the `.tool` stores it once on the tool's page. Never the key itself. |
| `scopes` | required | the OAuth scopes the API needs: one scope, a space-separated list, or a list |
| `subject` | optional | a user's email to act as, for a service account granted domain-wide delegation |

The token always comes from Google's own token endpoint; a `token_uri` inside the key is ignored. Give the service account access in the Google product itself (for example add its email as a user of the Google Ads account or the Tag Manager container), or that product refuses every call with an error of its own. When Google refuses the key itself (a revoked key, a scope the account may not have, a subject without delegation), the error names the service account and Google's reason, never the key.

The block works in one place: an inline tool's `tool_call_template` with `call_template_type: http`. Anywhere else (an `sse`, `streamable_http` or `mcp` template, or a `type: http` / `type: mcp` tool that discovers its tools from a `url`) no token would be sent, so the `.tool` is refused and `list_tool_setup` names it under `invalid`, saying where the block was found. It works the same for a `remote: false` tool run by the local `hexis-mcp` server, which mints the token on the machine it runs on.

A service account is one shared identity. To have each person call Google as themselves instead, do not use this block: declare a sign-in variable (`oauth`, above) and send it as `Authorization: Bearer ${VAR}`.

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

**A released tool or skill is live within ten seconds — no reconnect.** A commit on the default branch that adds, changes or removes a `.tool`, an `mcp.json`, a `plugin.json` or a `SKILL.md` drops the catalogs at once, whichever way the commit arrived: the app, the file tools, a git push, or an approved change request being applied. The hosted endpoint is stateless — it reads the live catalog on every request, so the very next call sees the change. The local `hexis-mcp` server checks the workspace's catalog whenever its connection is USED — when a tool call finishes, and when a client lists the tools — and re-registers what changed, local-only servers included; on a connection in use the change is there within ten seconds of the commit — unless a tool call is still running on that connection, which holds the refresh for as long as that call runs, to a limit of fifteen seconds (see the caveat below) — and `list_tools`, `list_tool_setup` and `list_local_tools` then answer with the new state on the connection you already have. A listing runs a check and waits for it, so what you are handed is never a list a refresh is halfway through replacing; checks are collapsed to at most one every two seconds, so a listing arriving inside that window is answered from what the last check confirmed rather than from a fresh read — up to two of those ten seconds are that window alone, before the workspace has been asked anything. After a call, the change lands once that call finishes, so a new tool is callable from the call after that one. An IDLE connection is deliberately outside that window: it asks the workspace nothing about its catalog, holds nothing open beyond the one MCP session it serves tools through, and is told nothing — no catalog timer, no extra socket parked per laptop, so an unused connection costs the workspace nothing more than being connected (a browser-signed-in server still renews its own sign-in shortly before it expires, a single request every few hours) — and it catches up at its next use. Skills need no check at all: the released skill catalog is cached briefly and dropped the moment the default branch changes, so a committed `SKILL.md` is in the very next `list_skills` or `get_skill` answer, and the two resolve a skill the same way, so a skill you can load by name is a skill the listing shows.

The platform also sends the MCP tool-list-changed and prompt-list-changed notifications when it can. **A client that CACHES the list it got at connect time — rather than honouring those notifications — will not see the change: it must re-list, or reconnect.** That is a property of the client, not of the workspace; if a tool you just wrote is missing, call `list_tools` again before assuming anything is wrong. One caveat on the local `hexis-mcp` server: a refresh there waits for a tool call that is still running, but only for fifteen seconds, so a commit made mid-call lands once that call finishes — or, if the call is still running after those fifteen seconds, while it is still running — and a LOCAL-only server (`local: true`, or a `type: "stdio"` command) that changed is restarted by that refresh, so a call to it made in the same moment may see it come back.

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
