---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

Move `Groups/` to `Plugins/`, laid out per the [Agent Plugins](https://agent-plugins.org) specification (v1.0.0).

A plugin folder now carries a `plugin.json` manifest, its skills under `skills/`, and its MCP servers in `mcp.json` — the three things a conformant client knows how to read. Existing knowledge bases migrate themselves: the seed top-up renames the root, writes the manifests, moves skill folders and `.tool` files, and commits it, so every deployment self-heals on the next load of a protected branch. The migration is idempotent, finishes a half-done run, and refuses to guess when both roots exist.

Two parts of a plugin are deliberately outside the portable core:

- **`access.md` stays at the plugin root.** Access resolution walks repo root → file directory accumulating rules, so the same file one level down would govern only that subtree — silently narrowing what it protects.
- **`.tool` manuals move to `software.bevel.hexis/tools/`**, the reverse-DNS namespace the spec reserves for exactly this. The specification describes MCP servers only and has no way to express an `http` or `inline` UTCP manual.

`.tool` files MOVE rather than convert, `mcp`-type ones included, and `mcp.json` is written as a *projection* of them. A manual carries its own access verbs and the `id` that secrets are namespaced under, and `mcp.json` has no field for either — converting would silently drop a tool's access rules and unbind its configured secrets. The `.tool` file remains what this platform reads.

Folder names keep their casing (`Plugins/Sales/`): the spec constrains the manifest's `name` field to a lowercase slug but says nothing about the directory, which is located by path. The slug is derived from the folder with separator runs collapsed, so a `personal-<user-id>` folder cannot produce a `--` that would fail schema validation.

Note that `${VAR}` references to the Secrets Vault are not portable — the spec defines expansion for `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` only, so another client reads them literally. That is inherent to a server-side vault: the secret cannot live in the file.
