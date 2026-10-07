---
name: review
description: |
  Pre-landing code review. Analyzes the diff against the base branch for SQL and data
  safety, race conditions, LLM trust-boundary violations, shell injection, enum
  completeness and other structural problems, fixes the mechanical ones and asks about
  the rest. Use when asked to "review this PR", "code review", "pre-landing review" or
  "check my diff", and when someone is about to merge.
---

# Pre-landing review

## Step 0: Find the base branch

Use the pull request's base if there is one (`gh pr view --json baseRefName -q .baseRefName`), otherwise the repository's default branch (`git symbolic-ref refs/remotes/origin/HEAD`), otherwise `main`. Call it `<base>` below.

## Step 1: Check the branch

1. `git branch --show-current`. On the base branch, say **"Nothing to review — you're on the base branch or have no changes against it."** and stop.
2. `git fetch origin <base> --quiet`, then `git diff "$(git merge-base origin/<base> HEAD)" --stat`. No diff: say the same and stop. If the fetch failed, carry on against the base you have and say the review is against a stale base.

## Step 1.5: Scope drift

Read the pull request description, the linked issue, or the plan for this branch if there is one (an office-hours design doc or a plan-eng-review in the knowledge base counts). Compare it with what the diff actually does: flag work the plan promised that is missing, and changes that go beyond it. Both are informational findings, not blockers.

## Step 2: Read the checklist

Read `checklist.md` beside this file. If it cannot be read, stop and say so — do not review without it.

## Step 3: Read the diff

Read the **full** diff against the merge base, including uncommitted and new files on the branch. Do not comment on anything before you have read all of it, and never flag something the diff already addresses.

## Step 4: Critical pass

Apply the checklist's two passes in order — CRITICAL, then INFORMATIONAL — and respect its suppressions.

- **Enum and value completeness needs code outside the diff.** When the diff adds an enum value, status, tier or type constant, search for every place that uses its sibling values, read those files, and check the new value is handled.
- **Search before recommending.** For fixes involving concurrency, caching, auth or framework behaviour, check current practice for the installed framework version and whether a built-in replaces the workaround (with web search if you have it; otherwise say you could not check).
- **Shared code is advisory.** Suggest an extraction only with at least one changed location in this diff and at least two real callers needing the same behaviour; prefer an existing helper. Never apply one without asking.
- **TODOs:** if the repository has a `TODOS.md`, note items this change completes ("This PR addresses TODO: …") and new TODOs it introduces.
- **Docs:** if the change alters a feature or workflow that a doc in the repository, or a page in the knowledge base, describes and that doc was not updated, flag it as informational.

**Confidence.** Give each finding a confidence from 1 to 10 and say what it rests on. Report findings you are confident in; put a speculative one in a short "worth a look" list rather than presenting it as a defect. Verify every claim: cite the line that proves a safety claim, read the handling code you rely on, and name the test file and test for a coverage claim. "This looks fine" is not evidence.

## Step 5: Fix first

Classify each finding with the checklist's **Fix-First heuristic**: AUTO-FIX when the fix is mechanical and a senior engineer would apply it without discussion, ASK when reasonable engineers could disagree. Critical findings lean towards ASK, informational ones towards AUTO-FIX. A finding that comes with a proposed test is always ASK.

1. **Apply every AUTO-FIX**, one line each: `[AUTO-FIXED] [file:line] Problem → what you did`.
2. **Ask about the ASK items together:** numbered, each with its severity, the problem and the recommended fix, and per item **A)** fix as recommended **B)** skip. Give an overall recommendation. With three or fewer, asking one at a time is fine.
3. **Apply the approved fixes.** For a defect with a regression test, write the test first and show it fails on the original code, then fix, then run the test, the original reproduction and the nearby happy path. If you cannot run the proof, say so and do not claim a verified fix: `[FIXED + TEST] [file:line] Problem → fix + test at <path>`.
4. **Re-review after edits**, at most three rounds. If findings keep coming back after the third, stop and report what is left.

Never commit, push or open a pull request in this skill — that is the person's call.

## Step 6: Report

One report, in the checklist's output format:

```
Pre-Landing Review: N issues (X critical, Y informational)

**AUTO-FIXED:**
- [file:line] Problem → fix applied

**NEEDS INPUT:**
- [file:line] Problem description
  Recommended fix: suggested fix
```

N counts the unresolved defects that remain. Keep fixed, skipped and advisory items in their own groups. If nothing was found: `Pre-Landing Review: No issues found.`

## Important rules

- **Read the full diff before commenting.**
- **Fix first, not read-only.** AUTO-FIX items are applied directly; ASK items only after approval.
- **Be terse.** One line for the problem, one for the fix. No preamble, no "looks good overall".
- **Only flag real problems.**
