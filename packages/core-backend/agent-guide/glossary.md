## Words used here

- **Knowledge base**: this organisation's documents, skills and tools in one
  repository, with access set per folder.
- **Default branch** (`{{defaultBranch}}`): what is live. Other protected
  branches may exist; `list_branches` marks each with `isProtected`.
- **Draft**: any branch that is not protected. Work waits there for review,
  visible to whoever opens the draft.
- **Change request**: the request to merge a draft into a protected branch.
- **Plugin**: a package: a folder under `{{pluginsDir}}/` with a `plugin.json`.
  It holds or links skills and declares tools, and its `access.md` says who
  uses it. Each person also has a private one (`my_plugin`).
- **MCP server**: a connection to another service, declared in a plugin's
  `mcp.json`. Its tools appear in the tool list as `<server>_<tool>`.
- **Tool**: one action an agent can call: one of the platform's own
  (`read_file`), one from a plugin's MCP server, or one from a tool manual.
- **Tool manual**: a `.tool` file in a plugin that describes HTTP tools, for a
  service without an MCP server.
- **Skill**: a folder with a `SKILL.md`: instructions an agent loads
  (`get_skill`) when the skill's description fits the task.
- **Secret**: a credential a tool needs, kept in the platform's Secrets Vault,
  never in a file or in the chat. A *shared* (admin) secret is set once, by
  someone who may edit the tool, for everyone who uses it. A *personal* (user)
  secret is set by each person for themselves.
- **Sign-in** (OAuth): a personal secret filled by signing in to the service
  instead of pasting a key.
- **Connect page**: where each person sets their personal secrets and signs in
  to tools.
- **Role**: a capability the platform defines, such as `Admin`, with the people
  who hold it, in `roles.yaml`. Roles are pre-set: never create one.
- **Group**: a named set of people, such as a team or a project, in
  `groups.yaml` or synced from the organisation's directory. Groups are what
  `access.md` files usually grant.
- **`access.md`**: a folder's rules: who may `read`, `write`, `download` or be
  `owner` of what is in it. A folder inherits from the folders above it, and
  the nearest rule that names you decides.
