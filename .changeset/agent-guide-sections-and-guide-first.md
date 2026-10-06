---
'@bevel-software/platform-core-backend': minor
---

The agent guide is read as `AGENTS.md` only, one section at a time if wanted, and every tool says to read it first.

- `get_agent_guide` takes an optional `section` and returns that section alone; its description lists the sections the guide has, a distribution's own included. The whole guide comes back when no section is named.
- Every tool of the platform's own now opens its description with "Call `get_agent_guide` first and read the platform's guide before anything else here." The sentence that pointed at the shared rules from the end of each file tool's description, and from the end of `call_tool_chain`, is gone with it: the opener is the one pointer.
- `grep` searches the guide where `read_file` serves it: a search of the repository root, or of `AGENTS.md` itself, matches lines of the guide under that path, after the knowledge base's own `AGENTS.md` when it has one, with the line numbers a read gives.
- The name a deployment once gave the written guide is no longer honoured as an alias: `AGENTS.md` is the one name on every deployment, and the retired setting's saved value is ignored. The first start removes a copy written under any earlier name, as before.
