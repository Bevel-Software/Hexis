## Where a new file goes

Decide by what the file IS, not by which folder you happen to be able to write
to. Write access is not evidence that a file belongs somewhere.

- **A document goes under `{{knowledgeBaseDir}}/`.** Knowledge, notes,
  reports, tickets, specifications, plans, meeting minutes: anything written
  to be read by a person, unless a section of this guide names a more specific
  home for that kind of file. Its shape inside is yours to choose.
- **A shared skill goes under `{{skillsDir}}/`**, or under
  `{{pluginsDir}}/<Plugin>/skills/<skill>/SKILL.md` when it belongs to one
  plugin alone. A person's private skill goes in their personal plugin
  (`my_plugin`).
- **Tool manuals, MCP servers and manifests go inside a plugin:** `.tool`
  manuals under `{{pluginsDir}}/<Plugin>/software.bevel.hexis/tools/`, servers
  in its `mcp.json`, `plugin.json` at its root.
- **A plugin folder never holds a document.** A ticket or a report written
  there is filed where nobody looks for it, under rules written for tools.
- **A personal plugin holds only its owner's skills and tools**
  (`{{pluginsDir}}/personal-<id>/`), with each skill's own files (references,
  scripts, assets) in that skill's folder, and never a note or any other
  document. When the user wants knowledge kept private, ask where under
  `{{knowledgeBaseDir}}/` it should go, and say that a folder there can be
  restricted so only they can read it. If they insist on
  the personal plugin, decline and say why: only they would ever find it, and
  never where the organisation looks for knowledge. Then offer a place under
  `{{knowledgeBaseDir}}/` again.
- **When the place does not exist, or nothing fits, ask.** If the user names a
  folder that is not there, or the file is of a kind this knowledge base has no
  home for, say so and ask. A wrong guess is found much later than a question.

### A team's first project

When a team starts out, propose one folder per project with one place for each
question, agree it with the person, and fill one page as an example before
anyone builds more:

```text
{{knowledgeBaseDir}}/<Team>/<Project>/
├── README.md         what the project is, who owns it, links to the pages below
├── Requirements.md   what it should do, and for whom
├── Status.md         where it stands: decisions, open questions, next steps, dated
├── Design.md         how it is built
└── Delivery.md       who delivers what, by when
{{skillsDir}}/<Team>/<skill>/SKILL.md   the team's shared skills
```

One question, one place: a decision goes in `Status.md`, not in a new page
beside it. A page that outgrows one screen becomes a folder of its own, with a
`README.md` linking its parts. Give the team's folder an `access.md` when not
everyone should read or change it (see `for-git-users` for an example). Search
first: when another team already covers a subject, link to its page rather
than start a rival.
