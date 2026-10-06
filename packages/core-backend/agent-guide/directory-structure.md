## Directory Structure

```text
{{kbDirName}}/
├── {{knowledgeBaseDir}}/        ← the knowledge itself; organise it however suits you
├── {{skillsDir}}/               ← shared skills, organised by who owns them
├── {{pluginsDir}}/              ← one folder per plugin: its tools, and links to skills
├── roles.yaml            ← identity → role mapping (Admin-only edits)
└── access.md             ← repo-root access-control rules
```

(The three root names above are this deployment's own — a deployment may
rename them in its setup screen, and this guide is rendered with the names in
effect each time it is composed.)

Tool paths are workspace-relative, and the workspace root holds this
repository as the `{{kbDirName}}/` folder (this deployment's own name for its
checkout): a file in it is `{{kbDirName}}/{{knowledgeBaseDir}}/Foo.md`. Write
the prefix where you can — it is the path every tool reports back — but a
path without it is PLACED under `{{kbDirName}}/` rather than refused, so
`{{knowledgeBaseDir}}/Foo.md` names that same file, and so does the
root-anchored `/{{kbDirName}}/{{knowledgeBaseDir}}/Foo.md` the app's Copy
path gives you. Nothing you send can land beside the repository,
where git would never see it. `.` or `..` segments, backslashes and every other
absolute path are refused.

Only those three folders are structural. `{{skillsDir}}/` holds shared skills at any
depth — the folder that holds a `SKILL.md` is the skill, and everything above
it is ownership (`{{skillsDir}}/<scope>/…/<skill>/SKILL.md`, with an `access.md` in
any scope folder that needs its own rules). `{{pluginsDir}}/` has a layout the
platform reads:

```text
{{pluginsDir}}/<Plugin>/plugin.json                  the manifest (Agent Plugins) — what makes the folder a plugin; its `name` is the plugin's identity
{{pluginsDir}}/<Plugin>/skills/<skill>/SKILL.md      a skill that lives inside the plugin
{{pluginsDir}}/<Plugin>/mcp.json                     MCP servers (authoritative)
{{pluginsDir}}/<Plugin>/software.bevel.hexis/tools/  `.tool` manuals
{{pluginsDir}}/<Plugin>/access.md                    who can read/write the plugin
{{pluginsDir}}/personal-<user-id>/…                  one per person: private
```

**The manifest's `name` is the plugin.** It is a kebab-case identifier
(`sales-team`), and it is what every grant spells (`plugin/sales-team/read`),
what the URLs and the catalog key on, and what the compiled marketplace
publishes the plugin as. `displayName` is what people see it called ("Sales
Team"); absent, the folder name is shown. Rename a plugin from its page in the
app: an identifier change rewrites every grant that names it, in one commit —
editing `name` by hand leaves those grants pointing at a plugin that no longer
exists.

**A plugin LINKS shared skills rather than containing them.** Its manifest
lists skill paths under `extensions["software.bevel.hexis"].skills` — each
entry is one skill folder or a folder of skills under `{{skillsDir}}/`:

```json
{ "extensions": { "software.bevel.hexis": { "skills": ["{{skillsDir}}/Engineering/deploy", "{{skillsDir}}/Sales"] } } }
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

**Symlinks are not supported anywhere under `{{pluginsDir}}/`.** Access control
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

**Plugin folders are made through the platform, not by writing files.** A
folder is a plugin exactly when it carries a `plugin.json` (the platform
writes one into every legacy plugin folder at startup), and it is LISTED only
when it also carries an `access.md` — a bare directory under `{{pluginsDir}}/` is
neither. Plugins may sit at any depth under `{{pluginsDir}}/`; a folder that holds
plugins deeper down is a grouping folder, not a plugin. A new plugin needs an
`access.md` naming who runs it, and the write gate refuses a plain write
into an unused name there — so do not try to create a plugin by writing a
skill into `{{pluginsDir}}/<new-name>/…`; it will be denied. Use the two tools
instead:

- `my_plugin` — your user's own private space, created on first use:
  `{{pluginsDir}}/personal-<id>/`. Readable only by its owner — not even
  admins — and never listed as a plugin. Their personal skills go under its `skills/`,
  each in its own folder with a `SKILL.md`; write there with the file tools.
- `create_plugin` — a shared plugin, named, optionally inside a grouping
  folder under `{{pluginsDir}}/` (`parent`). The caller runs it; others join
  through the app or are granted in its `access.md`.

The app's **New plugin** button and `POST /api/plugins` do the same. A skill
moves from a personal space into a plugin by moving its folder.

Everything under `{{knowledgeBaseDir}}/` is yours to arrange. Subfolders, naming,
whether a topic is one file or twenty — all of it is a judgement call about
what the next reader needs, not a rule the platform enforces.

A deployment may reserve further root folders of its own — `Data/`, `Agents/`
and `Pipelines/` scaffold an agentic execution layer in some installations.
They are not part of this template and are not created here; where they exist,
each carries its own `README.md` describing what belongs in it.
