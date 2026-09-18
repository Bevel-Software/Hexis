---
'@bevel-software/platform-core-backend': patch
---

The agent guide now says where a new file belongs. `AGENTS.md` gains a "Where a new file goes" section, rendered with the deployment's own root folder names: any document — knowledge, notes, reports, tickets, plans, minutes — goes under the knowledge root; a shared skill goes under the skills root or inside the plugin that owns it; tool manuals, MCP server declarations and manifests go inside a plugin; a plugin folder never holds a document; and when the user names a place that is not there, or nothing fits, the agent asks instead of falling back on a folder it happens to be able to write to.

The guide described the three roots but never said which kind of file belonged in which, so an agent asked to file a ticket wrote it into a plugin folder — the one place it already held write rights. Every deployment picks the section up on its next restart, in the written file and in the copy an MCP session reads.
