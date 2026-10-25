## Directory Structure

```text
{{kbDirName}}/
├── {{knowledgeBaseDir}}/        ← the knowledge itself; organise it however suits you
├── {{skillsDir}}/               ← shared skills, organised by who owns them
├── {{pluginsDir}}/              ← one folder per plugin: its tools, and links to skills
├── roles.yaml            ← who holds which role (Admin-only edits)
├── groups.yaml           ← who is in which group
└── access.md             ← the access rules at the root
```

(The three root names are this deployment's own: a deployment may rename them
in its setup screen, and this guide names the folders in effect.)

Tool paths are workspace-relative, and the workspace root holds this
repository as the `{{kbDirName}}/` folder: a file in it is
`{{kbDirName}}/{{knowledgeBaseDir}}/Foo.md`. Write the prefix where you can, as
every tool reports paths with it; a path without it is placed under
`{{kbDirName}}/`, so `{{knowledgeBaseDir}}/Foo.md` and the app's Copy path
`/{{kbDirName}}/{{knowledgeBaseDir}}/Foo.md` name the same file. A leading
`./` and doubled slashes are tidied away; `..`, any other `.` segment,
backslashes and other absolute paths are refused.

Only those three folders are structural, and `Data/`, `Agents/` and
`Pipelines/` are reserved names on every deployment. Under
`{{knowledgeBaseDir}}/`, subfolders, naming and whether a topic is one file or
twenty are yours to decide. `{{skillsDir}}/` holds shared skills at any depth:
the folder that holds a `SKILL.md` is the skill, and the folders above it are
ownership (`{{skillsDir}}/<scope>/…/<skill>/SKILL.md`, with an `access.md` in
any scope folder that needs its own rules). `{{pluginsDir}}/` has a layout the
platform reads:

```text
{{pluginsDir}}/<Plugin>/plugin.json                  the manifest: what makes the folder a plugin; its `name` is the plugin's identity
{{pluginsDir}}/<Plugin>/skills/<skill>/SKILL.md      a skill that lives inside the plugin
{{pluginsDir}}/<Plugin>/mcp.json                     its MCP servers
{{pluginsDir}}/<Plugin>/software.bevel.hexis/tools/  its `.tool` manuals
{{pluginsDir}}/<Plugin>/access.md                    who can read and write the plugin
{{pluginsDir}}/personal-<id>/…                       one per person: private
```

**The manifest's `name` is the plugin.** It is a kebab-case identifier
(`sales-team`): what every grant spells (`plugin/sales-team/read`) and what the
app and the marketplace key on. `displayName` is what people see ("Sales
Team"); without one, the `name` is shown. Rename a plugin from its page in the
app, which rewrites every grant naming it in one commit. Editing `name` by hand
leaves those grants pointing at a plugin that no longer exists.

**A plugin links shared skills rather than containing them.** Its manifest
lists skill folders, or folders of skills, under `{{skillsDir}}/`:

```json
{ "extensions": { "software.bevel.hexis": { "skills": ["{{skillsDir}}/Engineering/deploy", "{{skillsDir}}/Sales"] } } }
```

A plugin's skills are the ones in its own `skills/` folder plus everything its
links resolve to, and one skill can be linked by many plugins. Do not edit that
list by hand: link from the plugin's page in the app, which also grants the
plugin's members read on the skill (see `access-control`). A link without that
grant is repaired automatically when someone who may write the plugin opens its
page; one that cannot be repaired that way shows as needing setup. Who may read
a skill is decided by the skill's own folders, never by the plugin: a plugin
linking a skill someone cannot read simply does not show it to them.

**MCP servers go in `mcp.json`, not in `.tool` files.** Each `mcpServers` key
is the server's identity and the namespace its secrets bind to, so renaming a
key unbinds every configured secret and sign-in. `mcp.json` says only where the
server is (`type`, `url`, plain headers). Everything else the platform needs
(headers carrying `${VAR}` secrets, `variables`, a `description`, or
`local: true` for a server reachable only from a user's machine) goes in
`plugin.json` under `extensions["software.bevel.hexis"].mcpServers[<name>]`.
Secrets never go in `mcp.json`: plugins follow the
[Agent Plugins](https://agent-plugins.org) specification (v1.0.0), which other
clients load, and it has no place for credentials. A `type: "stdio"` server
runs on the user's machine through the local `hexis-mcp` server, never on the
hosted endpoint; it should exit when its standard input closes.

**Make plugins with the tools, not by writing files.** A folder is a plugin
when it has a `plugin.json` (or the read-only `plugin.bundle.json` format), and
it is listed only when it also has an `access.md`. Writing files into a new
name under `{{pluginsDir}}/` makes neither: on a protected branch it is
refused, and on a draft it makes a folder that is not a plugin. Use:

- `my_plugin`: the user's personal plugin, `{{pluginsDir}}/personal-<id>/`,
  created on first use. Only its owner can read it, admins included, and it is
  never listed as a plugin. Their own skills go in its `skills/` folder, each in
  a folder with a `SKILL.md`. A note or any other document goes under
  `{{knowledgeBaseDir}}/` instead (see `where-a-new-file-goes`).
- `create_plugin`: a shared plugin, named, optionally inside a grouping folder
  (`parent`). The caller runs it; others join through the app or are granted
  in its `access.md`.

The app's **New plugin** button does the same. A skill moves from a personal
plugin to a shared one by moving its folder. Symlinks are ignored anywhere
under `{{pluginsDir}}/`: access is resolved by path, and a second path to the
same file could disagree about who may read it.
