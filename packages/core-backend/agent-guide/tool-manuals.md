## Tool Manuals (`{{pluginsDir}}/<Plugin>/software.bevel.hexis/tools/*.tool`)

A `.tool` file is a **tool manual**: it lets agents call a service's HTTP API.
It lives in a plugin's `software.bevel.hexis/tools/` folder, beside the skills
that use it. `.tool` files are for `http` and `inline` manuals only: an MCP
server belongs in the plugin's `mcp.json` (see `directory-structure`). Who may
use and who manages a tool is in `tools`.

**The tool is the frontmatter.** A `.tool` is one `---` YAML block holding
everything: its `id`, its access verbs (`read`/`write`/`owner`/`download`,
which override the folder's `access.md` for this file) and its config
(`type`, `url`, `variables`, …). Anything after the closing `---` is notes the
parser ignores. A file without the fence is the older form: the whole file is
the object, so a bare JSON `.tool` still works.

```yaml
---
id: my_tool
write:
  - group/Product Team
type: http
url: https://api.example.com/utcp
---
```

`type` decides how the tools are found: **`inline`** embeds them in the file,
**`http`** points `url` at an endpoint that returns a UTCP manual.
(`type: mcp` is an older way to declare an MCP server; startup moves such files
into `mcp.json` where it can. Do not write new ones.)

**`id` is the manual's identity**: the namespace its secrets bind to and its
address. Use lowercase `snake_case`. Without an `id`, the `name`, then the file
name, is used. It must be unique among all `.tool` files and `mcp.json` server
names, and names differing only in `-` and `_` collide: the second is refused
(an `mcp.json` server wins over a `.tool`), not renamed, and `list_tool_setup`
names it under `invalid`. The same service in two plugins needs two ids
(`serper_everyone`, `serper_finance`), each with its own secrets and access.

### Secrets: `${VAR}` and `variables`

Wherever a manual needs a credential, write a placeholder such as
`${API_KEY}`. At call time it is filled from the platform's Secrets Vault,
under a key made from the manual's id and the variable's name, so a secret
belongs to one manual. The app's Secrets page shows the exact key; do not spell
it by hand.

Declare who provides each variable in an optional `variables` list of
`{ name, scope, label? }`:

- **`scope: admin`** (the default): set once by a writer of the file and shared
  by everyone who uses the tool. Prefer it.
- **`scope: user`**: each person sets their own.

`name` matches `[A-Za-z0-9_]+`. A `${VAR}` you do not declare is `admin` and
still shows in the app, so the list is needed only for `user` scope, a label,
or a sign-in. Values are entered in the app, never in the file. A malformed
entry makes the whole file fail to load (it then shows under `invalid`).

### Sign-ins: the `oauth` block

A `user` variable can be filled by signing in instead of typing a value: add
an `oauth` block, and the token rides in whatever header uses `${VAR}`. The
block carries public settings only:

| field | | |
|---|---|---|
| `clientId` | required | the OAuth app's client id; its owner registers the app with the redirect URI `<backend>/api/secrets/oauth/callback` |
| `authorizationUrl`, `tokenUrl` | required in a `.tool`; optional on an `mcp.json` server | an MCP server's are discovered from its own OAuth metadata, so give them only when that discovery fails. Both or neither |
| `scopes` | optional | `string[]`, requested at sign-in |
| `pkce` | optional, default on | only `false` means anything |
| `resource` | optional | the RFC 8707 resource indicator; discovered on an `mcp.json` server |
| `authParams` | optional | extra fixed parameters, such as Google's `access_type: offline` |

**Never** a `clientSecret`: a `.tool` with one fails to load, and an `mcp.json`
server whose entry has one is dropped. The secret is pasted once on the tool's
page. For an `mcp.json` server, the declaration goes in `plugin.json`, beside
the header that uses it:

```json
{ "extensions": { "software.bevel.hexis": { "mcpServers": { "hubspot": {
  "headers": { "Authorization": "Bearer ${HUBSPOT_TOKEN}" },
  "variables": [{ "name": "HUBSPOT_TOKEN", "scope": "user", "label": "HubSpot sign-in",
                  "oauth": { "clientId": "<the app's client id>" } }]
} } } } }
```

### Google APIs as a service account

Some Google APIs (Ads, Tag Manager, BigQuery, Sheets) are called as one shared
service account, with a short-lived token minted from its key. Name the key in
an `auth` block on an inline tool's `tool_call_template` (with
`call_template_type: http`), and the platform mints, caches and sends the token:

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

`credentials` is always a `${VAR}` holding the key JSON (whole, or base64);
`scopes` is required; `subject` (optional) is a user to act as, for a service
account with domain-wide delegation. The block anywhere else is refused and
named under `invalid`. Give the service account access in the Google product
itself. To have each person call Google as themselves, use a sign-in
(`oauth`) instead.

### Examples

An `http` manual with a shared and a personal key:

```yaml
---
id: weather
type: http
url: https://api.weather.example/utcp
headers:
  Authorization: Bearer ${ORG_KEY}
  X-User-Key: ${USER_KEY}
variables:
  - { name: ORG_KEY,  scope: admin, label: "Org-wide weather key" }
  - { name: USER_KEY, scope: user,  label: "Your personal weather key" }
---
```

An `inline` manual with one tool:

```yaml
---
id: billing
type: inline
variables:
  - { name: BILLING_KEY, scope: admin }
tools:
  - name: create_invoice
    description: Create an invoice.
    inputs: { type: object, properties: {} }
    outputs: { type: object, properties: {} }
    tool_call_template:
      call_template_type: http
      http_method: POST
      url: https://api.billing.example/invoices
      headers: { Authorization: "Bearer ${BILLING_KEY}" }
---
```

### Adding a third-party tool

When asked to add a product as a tool ("add Notion", "wire up Linear"), never
invent an endpoint or write a placeholder URL:

1. **Find the real endpoint in the vendor's own docs**, preferring their
   official remote MCP server, else their REST API. Confirm the URL, transport
   and auth with a web search, not from memory; without web access, ask the
   person.
2. **Pick the home.** An MCP server is an entry in the plugin's `mcp.json`
   (`type: "streamable-http"` and the `https://` URL, never `ws://`). A REST
   API is a `.tool` with `type: http`, or `type: inline` when you write each
   call by hand.
3. **An OAuth-protected MCP server usually needs only its `mcp.json` entry.**
   The app probes it, registers itself and offers a sign-in on the Connect page
   (`oauth-auto`). An `Authorization` header or an `oauth` variable turns that
   discovery off, so add neither. Some providers do not support it
   (`oauth-manual`, such as HubSpot or Google): write the entry; once it is
   live, `list_tool_setup` answers `setup.kind` and `setup.reason` for it.
4. **For a key, use `variables`**, never a key in the file:
   `Authorization: Bearer ${NOTION_TOKEN}` and a `variables` entry with its
   scope.
5. **Mark tools that only work on the person's machine**: `local: true` on an
   MCP server's `plugin.json` entry, `remote: false` on a `.tool`.

All of it lands on a draft first, and goes live once merged (see `tools`).

**Walking an admin through `oauth-manual`:**

1. Register an OAuth app with the provider, with the redirect URI that
   `setup.reason` gives.
2. Ask for the app's **client id** (public, fine in the chat) and write the
   declaration: for an `mcp.json` server, the `variables` entry with
   `oauth: { clientId }` and the `Authorization: Bearer ${VAR}` header in its
   `plugin.json` entry; for a `.tool`, the same with `authorizationUrl` and
   `tokenUrl`. A person can do the same under "Edit server" on the tool's page.
3. Once the declaration is on `{{defaultBranch}}` (a draft's entry shows in
   `onBranchOnly` with no `setup`), run `list_tool_setup`: `setup.reason` must
   be gone. If the endpoints could not be discovered, add `authorizationUrl`
   and `tokenUrl` from the provider's docs.
4. The admin pastes the **client secret** into the tool's page, never into
   the file or the chat. Then everyone signs in on the Connect page.
