## Conventions

These are conventions, not validations — nothing rejects a file for breaking
them. They exist because a knowledge base people can navigate beats one that is
merely correct.

1. **Descriptive file names.** `Weekly-Sync-2026-03-14.md` beats `notes3.md`.
   Avoid spaces; they survive git fine but make links noisier to read.

2. **Markdown links between documents.** Use
   `[Page Name](relative/path/to/Page.md)`, relative to the LINKING file's
   directory rather than the repo root, so links resolve both in the app and on
   the git host.
   `move_file` keeps most of them working: it rewrites the links inside the
   moved files and those in the other markdown pages it searches, and names
   what it left — HTML pages, and pages you may not change. It does not search
   `transcripts/` or `probes/` folders, and pages you cannot read are neither
   searched nor named (the answer only says such pages may exist); links there
   can still point at the old path. Paths written in prose or code are not
   links, and a move leaves them as they are.

3. **Absolute dates.** `YYYY-MM-DD`, never "last Tuesday" — a saved file
   outlives the moment it was written.

4. **Search before creating.** If a document on the subject exists, extend it
   rather than starting a rival.

5. **Preserve what is there.** Append or edit sections; do not overwrite a file
   wholesale unless asked to.

6. **Say where it came from.** When a claim rests on a specific source — a
   person, a ticket, a document, a URL — name it inline near the claim, with
   the date it was true. The next reader's first question is "says who, and is
   it still true?".
