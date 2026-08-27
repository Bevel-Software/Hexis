# @bevel-software/hexis-mcp

Run a [Hexis](https://github.com/Bevel-Software/Hexis) workspace as a **local** MCP server.

A workspace already publishes a hosted MCP endpoint, and for most tools that is the right place to run them. But a `.tool` marked `remote: false` — an MCP server on `localhost`, a service that only answers inside your network — is one the hosted endpoint cannot reach. It skips those tools and can only name them, through `list_local_tools`.

This command closes that gap by being where those tools actually are, without giving up anything the hosted endpoint gives you.

```bash
npx @bevel-software/hexis-mcp --url https://your-workspace.example
```

## Signing in

Two ways in, and whether you pass a key decides:

**No key (the default)** — the command opens your browser to sign in to the workspace, the same sign-in the web UI uses. The credential that keeps you signed in lands in `~/.hexis/oauth/`, readable only by you, so later runs skip the browser. On a machine with no display, `--no-open` (or `HEXIS_NO_BROWSER=1`) prints the sign-in URL instead of opening anything — follow it from any browser. Browser sign-in needs a deployment at least as new as this package; against an older one the command says so, and a connection key still works there.

**With a key** — `--key bevel_…` (or `HEXIS_CONNECTION_KEY`) skips the browser entirely: the right mode for CI, pipelines, and anywhere nobody is present to sign in. Mint one from the profile menu → **External agent access**.

Either way, the credential authenticates *this process* and nothing else changes: tools still execute where they always did, and the workspace's Secrets Vault stays on the server.

## In Claude Code

```json
{
  "mcpServers": {
    "hexis": {
      "command": "npx",
      "args": ["-y", "@bevel-software/hexis-mcp"],
      "env": {
        "HEXIS_URL": "https://your-workspace.example",
        "HEXIS_CONNECTION_KEY": "bevel_…"
      }
    }
  }
}
```

Leave `HEXIS_CONNECTION_KEY` out and the first start opens your browser to sign in instead; after that the stored sign-in carries every start.

## What you get

Everything the hosted endpoint serves — the knowledge-base tools, your plugins' `.tool` integrations, and your skills as slash commands — **plus** the local-only tools. `call_tool_chain` here runs over the merged set, so one script can read a page from the workspace and hand it to a tool running on your laptop.

## Where credentials come from

This is the part worth understanding, because it decides which tools work.

A UTCP tool's `${VAR}` placeholders are filled in **by whichever process holds the client**. This server registers the deployment's own MCP endpoint as a single manual, so every remote tool still *executes on the server* — and keeps resolving its variables from the Secrets Vault there. A shared API key an admin set once, or a Notion sign-in someone completed on the Connect page, keeps working exactly as it does today. Nothing pulls those values onto your machine.

Local-only tools are the exception, necessarily: they run here, so their variables have to be here too. They are resolved from the **same Secrets Vault**, through one deliberately narrow route, and this is the boundary worth knowing:

- **The request names a manual, never a variable.** This process asks the workspace to resolve *what `mytool` declares*; the workspace re-reads that `.tool` file and answers with exactly those variables. The knowledge base is the allowlist, and nothing this process sends can widen it.
- **Only `remote: false` manuals resolve here.** A remote tool's credentials are used on the server and are refused by this route — moving them onto a laptop would be a wider exposure than the tool they unlock.
- **Values are never returned to an agent.** They are substituted into a tool invocation and go no further. An agent calls `git.push(...)`; it never sees the token that made the push work.
- **A browser session cannot use this route.** It answers the machine credential this process holds — a connection key, or the internal token a browser sign-in exchanges for — and refuses a web-UI session outright. Signed-in users in the web UI get the Secrets page, which is write-only. Both ways of running this command can therefore resolve a local tool's variables; neither lets a person read one back.

So: set a local tool's variables on the workspace's Secrets page, like any other tool's. Nothing has to be placed on each machine.

The environment still works as a fallback for tools provisioned the old way. Put the value in the `env` block of the MCP client config that launches the command, under the UTCP-namespaced name — the `id` from the `.tool` file, an underscore, then the variable. UTCP sanitizes the id first: every character that is not a letter, digit or underscore becomes `_`, then every `_` is **doubled**, so `mytool` + `API_KEY` → `mytool_API_KEY`, while `my-tool` or `my_tool` + `API_KEY` both become `my__tool_API_KEY`. (Two manuals whose ids differ only in `-` versus `_` therefore share a namespace; the workspace refuses the second, and this process refuses to resolve either.)

## Options

| Flag | Environment | Meaning |
|---|---|---|
| `-u, --url` | `HEXIS_URL` | Workspace base URL |
| `-k, --key` | `HEXIS_CONNECTION_KEY` | Connection key from External agent access; omit to sign in through your browser |
| `--no-open` | `HEXIS_NO_BROWSER` | Print the sign-in URL instead of opening a browser |
| `-h, --help` | | Usage |

The MCP endpoint itself is not a setting: the server asks the deployment for it (`/api/config`), so a workspace behind a proxy or on a second domain is handled without you configuring anything twice. Older deployments that do not advertise it fall back to `<url>/api/mcp`, with a warning on stderr.

## Troubleshooting

Diagnostics go to **stderr** (stdout carries the protocol), and MCP clients surface them as server logs.

- *"The connection key was rejected"* — the key was revoked or belongs to another workspace. Mint a new one.
- *"Your sign-in was rejected"* / *"could not be refreshed"* — the workspace revoked the sign-in, or it expired. Restart the command to sign in through your browser again.
- *"This deployment is too old for browser sign-in"* — the workspace predates the sign-in exchange. Upgrade it, or pass a connection key.
- **A local tool is missing from the list** — it registered but failed; the log names it and why. A tool whose local server is not running is the usual cause.
- **A local tool is listed but its calls fail on credentials** — its variable is not set on the workspace's Secrets page, and not in this process's environment either. The log names which variables came back unset. If you are using the environment fallback, note the namespaced prefix, with `-`/`_` in the tool id becoming `__`.
- **The log says two manuals share a namespace, or have nested ones** — neither resolves until one is renamed (shared), or a variable of the shorter manual whose name starts with `_` is avoided (nested).
- **A tool is missing entirely** — the workspace hides tools whose per-user credentials you have not set up yet, on key-authenticated sessions. Configure it on the workspace's Connect page.

## Licence

Apache-2.0
