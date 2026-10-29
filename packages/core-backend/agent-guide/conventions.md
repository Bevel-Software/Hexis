## Conventions

These are conventions, not validations: nothing rejects a file for breaking
them. They exist because a knowledge base people can find their way around
beats one that is merely correct.

1. **Descriptive file names.** `Weekly-Sync-2026-03-14.md` beats `notes3.md`.
   Avoid spaces: a link to a name with a space needs `%20` in its place.

2. **Markdown links between documents.** Write `[Page Name](relative/path/Page.md)`,
   relative to the folder of the page that holds the link, so it resolves in
   the app and on the git host. When you read a link, resolve it the same way.
   `move_file` keeps most links working: it rewrites the links in the moved
   files and in the other markdown pages it searches, and names what it left:
   HTML pages, raw HTML inside a page, and pages you may not change. It leaves
   `transcripts/` and `probes/` folders alone, even files moved out of them,
   and pages you cannot read (the answer only says such pages may exist). A
   move that would edit links in more than 200 files is refused unless you pass
   `rewriteLinks: false`. Paths written in prose or code are not links.

3. **Absolute dates.** `YYYY-MM-DD`, never "last Tuesday": a saved file
   outlives the moment it was written.

4. **Search before creating.** `grep` for the subject and `list_files` the
   folder first. If a page on the subject exists, extend it rather than start
   a rival.

5. **Preserve what is there.** Append or edit sections; do not overwrite a
   file wholesale unless asked to.

6. **Say where it came from.** When a claim rests on a source (a person, a
   ticket, a document, a URL), name it next to the claim, with the date it was
   true. The next reader's first question is "says who, and is it still true?".
