# @bevel-software/hexis-mcp

Run a [Hexis](https://github.com/Bevel-Software/Hexis) workspace as a **local** MCP server.

A workspace already publishes a hosted MCP endpoint, and for most tools that is the right place to run them. But a `.tool` marked `remote: false` — an MCP server on `localhost`, a service that only answers inside your network — is one the hosted endpoint cannot reach. It skips those tools and can only name them, through `list_local_tools`.

This command closes that gap by being where those tools actually are, without giving up anything the hosted endpoint gives you.

```bash
npx @bevel-software/hexis-mcp --url https://your-workspace.example --key bevel_…
```

Mint the key from the profile menu → **External agent access**.

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

## What you get

Everything the hosted endpoint serves — the knowledge-base tools, your plugins' `.tool` integrations, and your skills as slash commands — **plus** the local-only tools. `call_tool_chain` here runs over the merged set, so one script can read a page from the workspace and hand it to a tool running on your laptop.

## Where credentials come from

This is the part worth understanding, because it decides which tools work.

A UTCP tool's `${VAR}` placeholders are filled in **by whichever process holds the client**. This server registers the deployment's own MCP endpoint as a single manual, so every remote tool still *executes on the server* — and keeps resolving its variables from the Secrets Vault there. A shared API key an admin set once, or a Notion sign-in someone completed on the Connect page, keeps working exactly as it does today. Nothing pulls those values onto your machine.

Local-only tools are the exception, necessarily: they run here, so their variables resolve here, from this process's environment. Put them in the `env` block of the MCP client config that launches the command:

```json
"env": {
  "HEXIS_URL": "https://your-workspace.example",
  "HEXIS_CONNECTION_KEY": "bevel_…",
  "mytool_API_KEY": "…"
}
```

The name is the UTCP-namespaced form, `<manual-id>_<VAR>` — the `id` from the `.tool` file, then the variable it references. There is no way to read a Secrets Vault value from here, and that is deliberate: a vault secret arriving on a laptop is a wider exposure than the one tool it unlocks.

## Options

| Flag | Environment | Meaning |
|---|---|---|
| `-u, --url` | `HEXIS_URL` | Workspace base URL |
| `-k, --key` | `HEXIS_CONNECTION_KEY` | Connection key from External agent access |
| `-h, --help` | | Usage |

The MCP endpoint itself is not a setting: the server asks the deployment for it (`/api/config`), so a workspace behind a proxy or on a second domain is handled without you configuring anything twice. Older deployments that do not advertise it fall back to `<url>/api/mcp`, with a warning on stderr.

## Troubleshooting

Diagnostics go to **stderr** (stdout carries the protocol), and MCP clients surface them as server logs.

- *"The connection key was rejected"* — the key was revoked or belongs to another workspace. Mint a new one.
- **A local tool is missing from the list** — it registered but failed; the log names it and why. A tool whose local server is not running is the usual cause.
- **A local tool is listed but its calls fail on credentials** — its `${VAR}` is not in this process's environment. See above; note the `<manual-id>_` prefix.
- **A tool is missing entirely** — the workspace hides tools whose per-user credentials you have not set up yet, on key-authenticated sessions. Configure it on the workspace's Connect page.

## Licence

Apache-2.0
