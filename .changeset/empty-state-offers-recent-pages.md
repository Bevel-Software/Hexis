---
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-shared': minor
---

Knowledge now opens on what the team last worked on, instead of on four access
files.

With nothing open, the reader is offered somewhere to start. That offer was
built by walking the file tree breadth-first and taking the shallowest markdown
it found, which on a real knowledge base returns the access files and nothing
else: every folder carries the `access.md` that governs it, and that file sits
one level above the pages inside, so the walk reaches all of them before it
reaches a single page. The walk did skip an `access.md`, but only the copy at
the repository root, and it skipped it by starting below the root rather than
by recognising the name. The result was a front door that offered four
permission files, on every knowledge base whose folders have subfolders, which
is all of them.

The offer now comes from the branch's own history: the most recently changed
pages this reader is allowed to open, newest first. That is the question a
knowledge base should answer for someone arriving at it, and only the history
can answer it, since the file tree carries no timestamps and position in the
tree says nothing about what the team is working on. Recency never widens what
anyone can see: the candidates go through the same read filter the file tree
itself is built with, so a page someone else edited in a folder you were never
given is not offered to you. The tree walk stays as the fallback for a branch
with nothing committed yet, and it no longer offers an access file at any
depth.

`isAccessMdPath` moves to `kb-layout.ts` so both sides of the app ask one
question and get one answer. The resolver and the approval gate keep importing
it from the access model, which now re-exports it.

`platform-shared` takes a minor rather than a patch: `IWorkflowService` gains a
required `listRecentlyChangedPaths`, and the interface is published, so anyone
implementing it outside this repo has to add the method.
