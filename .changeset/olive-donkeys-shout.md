---
'@bevel-software/platform-core-frontend': patch
---

One open proposal per person per FILE, not per skill. Proposing a change to one
file used to hide "Propose changes" on every other file of that skill until the
first proposal was withdrawn or decided — the editor was gated on the caller
having any open change request touching the skill folder, so a pending edit to
SKILL.md locked the whole bundle. Each file now carries its own suggestion
branch (`suggestions/<user>/<skill>--<file>-<digest>`) and opens its own change
request, titled with the file so the owner's dock can tell several apart, and
each is approved or declined on its own.

The file lands flattened into the last branch segment (`--<file>`) rather than
nested under the skill (`/<file>`): a skill-level branch from before files were
in the name is a ref FILE at `refs/heads/suggestions/<user>/<skill>`, and
nesting would ask git to make that same path a directory — a D/F conflict that
would fail every propose for as long as the old branch existed. Requests opened
on those legacy branches are still recognised as the caller's own, and while
their touched paths are still uncomputed they hold every file of the skill
rather than offering an editor that would fork them.

File names also reach git's ref rules for the first time, so the branch slug now
collapses `..` and rewrites a trailing `.lock` — both are rejected outright by
the backend's branch-name validator, and a skill shipping a `deps.lock` beside
its SKILL.md would otherwise have been unproposable with only a bare 400 to
explain it.

Because that sanitising is lossy, the branch also carries a short digest of the
path it came from. Every character git will not take becomes `-`, so
`reference/DESIGN-SYSTEM.md` and `reference-design-system.md` reduced to the
same branch — and since a request is matched to the file on screen by branch,
the first file's pending request was served to the second as its own, leaving
the second unproposable and writing any proposal on it into the first file's
request. The digest is taken before sanitising, so the two stay apart. The
readable slug is now also truncated to fit git's 255-character ceiling on a
ref, which nothing upstream had bounded; the digest survives the truncation, so
two long paths sharing a prefix still get their own branches.

The owner's change-request dock gets the two things that per-file requests made
necessary: a `»` control that folds it to a slim tab on the viewport edge (it
is fixed-position chrome and can sit on the column it is about), and a cap of
three visible cards with the rest scrolling. The cap is measured from the third
card's own edge rather than set as a fixed height, because these titles wrap
anywhere from one line to four.
