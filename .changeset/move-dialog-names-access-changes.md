---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': patch
---

The move confirmation names who loses and who gains access. It used to say "Move contract.pdf to Sales? Access to it will follow Sales' rules from now on." — true, and a tester read it and could not tell what it meant for anyone. Now the dialog asks "Move contract.pdf to Sales?" and lists, under "Will lose access:" and "Will gain access:", one line per principal and verb: "Engineering: can no longer edit", "Ali Raza: can no longer open", "Product: can open". When neither list has an entry it says so outright — "Nobody's access changes."

A principal appears as its grant names it: a group where the grant is a group, a role where it is a role, a plugin's readers/writers/owners where it is a plugin principal, and a person only where the person is granted directly. A group is never expanded into its members — the question the dialog answers is which grants change, not which inboxes. The labels are the ones the Manage access sheet uses, so the two never describe one grant two ways. A block longer than six lines shows six and "and N more".

The lists come from a new `GET /api/workspace/:id/access/prospective?from=<file>&toDir=<folder>`, which answers the one question the existing access route cannot: who would hold read and write at a path the file has not moved to yet. It resolves the destination's folder chain with the file's own frontmatter layered on top — the frontmatter travels with the bytes, the folder rules do not — and writes nothing. The caller must resolve read on the file being moved; the lists name people, and someone who cannot see the file has no business learning who can.

The lookup decorates the confirmation, it never gates it. The dialog opens the moment the file is dropped and fills the blocks in when the answer lands; past two seconds it gives up, falls back to the sentence it used to say alone, and adds "Couldn't work out the access change." Move is enabled throughout — a confirmation a slow resolver could hang would be worse than one that says less. A move with either end outside the KB clone is governed by no access rules at all, and the dialog claims nothing about it.

The existing warnings — destination not writable, platform-managed file, move across root folders — keep their place below the access blocks.
