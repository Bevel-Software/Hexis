---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
---

`move_file` rewrites the links into, out of and between the files it moves.

Moving or renaming a file or folder used to leave every relative link pointing at the old place: those inside the moved files, the `nodeType` link in each node's frontmatter among them, and those in other pages pointing at the moved files. Agents recomputed them by hand.

A move now rewrites them by default, and lands the move and every edit in one commit, so git's rename detection pairs each moved file with its old path (a small file whose links make up most of its bytes can still fall below git's similarity threshold and show as a delete and an add). Every markdown link form is covered — relative, root-anchored `/knowledge-base/…` and `/workspace/<branch>/…`, angle-bracket and percent-encoded destinations, images and reference definitions — and each link keeps its form, anchor and title. Code, id-links and every other byte of a page are left as they were; in frontmatter only a value that is one whole link (the `nodeType` link, say) is rewritten. HTML pages are named, not rewritten, and so is a markdown page for the raw HTML (`<a href>`, `<img src>`) it carries. Transcripts and probe logs are not searched.

The dry run and the move answer the same `links` report: `filesEdited`, `linksRewritten`, the first 100 `edits`, the pages left `notRewritten` with the reason (a page the caller may not change on a protected branch, an HTML page, raw HTML inside a markdown page, the write hook's refusal), and, when the caller cannot read some pages, one sentence saying links there may still point at the old path — those pages are never opened, named or counted. A page the read hook refuses is treated the same way: not named, covered by that sentence. A move that would edit more than 200 files is refused; a lock another writer holds past the retries fails the whole move with nothing changed. `rewriteLinks: false` moves exactly as before.

For integrators: platform-shared exports the link grammar (`scanMarkdownLinks`, `resolveMdLink`, `rewriteMdLinks`, `retargetMdDestination`, `htmlLinksAffectedByMove`, `maskMarkdownCode`, `MD_ID_LINK_RE`), and `LockingFilesystem` gains `moveWithEdits`.
