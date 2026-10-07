## Where a new file goes

Decide by what the file IS, not by which folder you already hold rights in.
Write access is not evidence that a file belongs somewhere.

- **Read the area's `README.md` first.** Before you create, move or
  reorganise files in a folder, read the `README.md` of that folder and of
  each folder above it. A README there says how that area is organised:
  where each kind of file goes and what each subfolder holds. For that area
  its layout rules come before the general ones in this guide; they never
  widen what you may read or write. When you add a subfolder or a new kind of
  file there, or settle a new convention, update that README in the same
  change, so the next agent finds it.
- **A document goes under `{{knowledgeBaseDir}}/`.** Knowledge, notes,
  reports, tickets, specifications, plans, meeting minutes — anything written
  to be read by a person — unless a section of this guide below, or the
  `README.md` of a folder this deployment reserves, names a more specific
  home for that kind of file. That is what the root is for, and its shape
  inside is yours to choose.
- **A shared skill goes under `{{skillsDir}}/`**, or under
  `{{pluginsDir}}/<Plugin>/skills/<skill>/SKILL.md` when it belongs to one
  plugin alone. A person's private skill goes in their own space (`my_plugin`).
- **Tool manuals, MCP server declarations and manifests go inside a plugin:**
  `.tool` manuals under `{{pluginsDir}}/<Plugin>/software.bevel.hexis/tools/`,
  servers in that plugin's `mcp.json`, and `plugin.json` at its root.
- **A plugin folder never holds a document.** `{{pluginsDir}}/` carries
  machinery — manifests, tool manuals, server declarations, access rules, and
  the skills a plugin owns. A ticket or a report written there is filed where
  nobody will look for it, under rules written for tools.
- **When the place named does not exist, or nothing fits, ask.** If the user
  names a folder that is not there, or the file is of a kind this deployment
  has made no home for, say so and ask where it should go. Do not settle for a
  folder you happen to be able to write to; a wrong guess is discovered much
  later than a question.
