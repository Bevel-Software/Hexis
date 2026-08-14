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

`mcp`-type `.tool` files are CONVERTED into `mcp.json` entries — keyed by their manual id, which is the namespace secrets bind to, so configured secrets and completed OAuth grants stay bound — and the `.tool` is deleted; `mcp.json` is authoritative for MCP servers. What it cannot carry (auth headers with `${VAR}` references, variable declarations, the local-only flag) moves to `plugin.json`'s extensions block. `http`/`inline` manuals still move as `.tool` files: nothing but this platform can express them.

Folder names keep their casing (`Plugins/Sales/`): the spec constrains the manifest's `name` field to a lowercase slug but says nothing about the directory, which is located by path. The slug is derived from the folder with separator runs collapsed, so a `personal-<user-id>` folder cannot produce a `--` that would fail schema validation.

Secrets stay out of the portable files entirely. The specification defines no portable credential mechanism by design — "Authorization discovery, user interaction, and credential storage are client-managed" — states that header and `env` values are "visible package data, not a portable secret mechanism", and forbids expanding anything but `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`. The Secrets Vault is precisely the client-managed storage the spec defers to, so the `mcp.json` projection records only where a server is and drops any `${VAR}` header reference; those remain in the `.tool`, which this platform interprets. A literal, non-secret header (an API version, say) is carried through.
