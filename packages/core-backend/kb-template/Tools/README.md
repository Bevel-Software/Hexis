# Tools/

**Tool manuals** — `.tool` files that let agents call external APIs through
the platform's UTCP registry. Not part of the knowledge graph;
access-controlled like any other files. Subfolders for grouping are allowed.

## Structure

```text
Tools/
├── <tool_name>.tool      ← one manual per tool/integration
└── <grouping>/
    └── <other_tool>.tool
```

## What goes here

A `.tool` file is one YAML frontmatter block holding everything — identity,
access, and config:

```yaml
---
id: my_tool               # lowercase snake_case, unique — the secret namespace
write:
  - Product Team          # who can edit the tool and set its shared secrets
type: mcp                 # inline | http | mcp
url: https://mcp.example.com
---
```

- `type: inline` embeds the tool definitions in the file; `http` points at a
  UTCP manual endpoint; `mcp` points at a remote MCP server.
- **Never put secret values in the file.** Reference credentials as `${VAR}`;
  values live in the Secrets Vault under `<id>_<VAR>`. Declare per-user vs
  shared scope in a `variables:` block (`scope: admin` is the default).
- OAuth-protected MCP servers need nothing beyond `type: mcp` + `url` — the
  platform discovers the sign-in automatically.
- Add `remote: false` only for tools reachable solely from a user's own
  machine (e.g. a `localhost` MCP server).

Full syntax, secret scoping, and setup flows: repo-root `CLAUDE.md`
§ "Tool Manuals".
