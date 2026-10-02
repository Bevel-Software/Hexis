---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-mcp-core': patch
---

The rules every file tool shares are now stated once, and no tool description is long enough for a client to cut.

The content rule, the reminder to read the agent guide first, the write modes, the image convention, the escape-sequence warning, the dry-run/confirm protocol, what is never moved or deleted, and the proposal route used to be appended in full to every description they covered — so `read_file`, `file_stat`, `write_file` and `write_files` ran to two and three thousand characters, most of it text the agent had already read on the tool above, and clients cut it from the end, where what is specific to the tool sits. Agents saw those four arrive ending in "[truncated]".

Those rules now live in one source text that feeds two places: the `instructions` of the MCP initialize handshake, and a new "Working with files" section in the platform-managed agent guide at the repository root (`AGENTS.md` by default), which clients that drop `instructions` always have. Both get the identical string, so a rule cannot be changed in one and left stale in the other, and an existing knowledge base gains the section on its next boot the way every managed file is refreshed. Each tool description now holds only what is specific to that tool and ends with one sentence: `Shared rules for all file tools: see "Working with files" in AGENTS.md.`

Two limits are pinned by tests: no tool description a client is handed exceeds 1,200 characters (measured with the deployment's tool prefix for the tools that carry one), and the handshake instructions stay under 13,000. Nothing an agent could read before has been dropped — every rule is in the description that is specific to it, in both shared places, or on the tool's own input/output schema.

`call_tool_chain` ends with that sentence too: what a chained read does to an image is one of the shared rules, and the clients that drop `instructions` have only descriptions to go on. The pointer is composed where the tool is served, since the guide's name is a deployment setting.
