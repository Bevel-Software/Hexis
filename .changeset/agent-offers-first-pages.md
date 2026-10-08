---
'@bevel-software/platform-core-backend': minor
---

A connected agent offers to write the first pages of a new knowledge base.

While the knowledge folder on the default branch has no pages yet — nothing but the starter guide (`How to get started.md`), or nothing at all once someone has deleted that guide — `start_session` answers with a `firstRun` note beside the session id. It tells the agent the knowledge base is new and to offer, once and briefly, to draft its first pages — what the organisation does, its customers, its products, a glossary, how it works — from the person's website or a few sentences of theirs, after answering whatever the person actually asked. The agent guide has a new section, `new-knowledge-base`, saying how: write the pages with the normal file tools under the knowledge folder, and tell the person they are in the knowledge base to read and edit. Folder placeholders, dot-files and `access.md` files do not count as pages. Once any other file exists, the note stops on its own.

The check reads only a clone that is already on disk, stops at the first page it finds, and never fails the call: when it cannot tell, `start_session` answers with the session id alone, as before. Nothing is written to any repository, so existing deployments get the note and the section on upgrade, and only where the knowledge base is still empty.
