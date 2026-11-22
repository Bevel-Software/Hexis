---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-mcp-core': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

A bot is an identity of its own. It is a users row marked as a bot, with the address `<id>@agent.hexis` (an admin may change the domain), granted and denied access by that address like a person and through the groups it is in. It is not part of "everyone", holds no role, is never an admin, never signs in, is never mailed, and cannot change access: its writes to `roles.yaml`, an `access.md`, a group file or a file's own access lines are refused, and so is its merge of a change request that changes any of them.

The connection-key dialog and the sign-in consent step offer "Connect as": Myself, then each bot the person may act as (only who may write what defines the bot). A connection made as a bot acts as the bot's row on every call, with the bot's secrets and tool sign-ins, re-checked every call; when the bot cannot be used or its maker may no longer act as it, the connection loads nothing and says why. The audit log, a bot's commits (a `Made-by:` trailer), the change requests it opens and the merges it makes name the person beside the bot. The Secrets and Connect tools pages can be opened for a bot by a link naming it.

Breaking for a distribution: `CorePorts.agentScope` (an agent configuration that narrowed a person's connection) is replaced by `CorePorts.bots`, a bot directory (`IBotDirectory`: the definitions, who may act as each, the platform tools it is offered, and the bot a legacy agent path stands for). A distribution must move to it with this version. Core alone supplies no bot and behaves as before. Connections made "as an agent" before this keep working as that bot when the distribution maps the path to one and their owner may act as it; connections made as Everything are made as Myself.
