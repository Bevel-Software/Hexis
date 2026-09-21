---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

The platform's agent guide can be given a file name of its own, so a customer's `AGENTS.md` is never overwritten.

`AGENTS.md` is the name coding agents look for by convention, so a repository brought to Hexis very often already has one. Until now the platform wrote its managed guide to exactly that name and replaced it with the packaged template on every start — the customer's conventions gone on the first boot, and gone again on every boot after, with no warning and no way out.

**Agent guide file** is now a deployment setting, in the knowledge-base section beside the three root folder names, on first-run setup and on the Deployment settings page. It defaults to `AGENTS.md`, so a deployment that names nothing behaves exactly as before. Name it something else — `HEXIS.md`, say — and the managed guide is written and refreshed under that name on every protected branch, its own header names the file it lives in, and `AGENTS.md` at the root becomes ordinary content: never written, never refreshed, never hidden from the file tree, and movable and deletable like any page. The platform-file protections (immovable, undeletable) follow the configured name instead, in the server's gates and in the sidebar's confirmations alike. The name must be one file name, end in `.md`, and differ from `CLAUDE.md`, from the other platform files and from the three root folders; restart to apply, like the folder names.

Changing the name on a knowledge base that already carries an `AGENTS.md` removes that file on the next start ONLY when the platform can prove it wrote it — the managed header it writes into its own guide is the one thing asked, and a file that has been edited, or was the customer's all along, is left byte for byte as it was. The boot note says which of the two happened. Nothing is deleted on a guess.

A renamed guide is only useful if the customer's own file points at it, so beside the field is the exact sentence the platform would add to their `AGENTS.md` and a checkbox, on by default, to keep it there. While it is ticked, every start looks for the guide's name anywhere in the text of a customer-owned root `AGENTS.md` and appends the sentence at the end only when it is missing — a mention in their own words counts, and nothing is written then. No `AGENTS.md` is ever created for this, a platform-written one is never appended to, and unticking the box is how an admin says no.

Every instruction the platform gives an agent names the configured file, and when it is not `AGENTS.md` it tells the agent to read that one too, ours first: a remote agent has no checkout, so no harness reads the organisation's own conventions for it, and the link runs from their file to ours rather than the other way.

`KB_KNOWLEDGE_BASE_DIR`, `KB_SKILLS_DIR` and `KB_PLUGINS_DIR` are retired with this: the knowledge-base layout is entered in the app and nowhere else. A deployment that still sets one has its value imported once into the saved setting on the first start after upgrading, with a log line naming the variable to delete; where a saved value already differs, the saved value wins and the start warns that the variable is ignored. Nothing reverts to the defaults.
