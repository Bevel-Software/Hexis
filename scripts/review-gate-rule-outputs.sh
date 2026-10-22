#!/usr/bin/env bash
# The architecture-review workflow's format gate: does a one-pager carry a
# non-empty "Rule outputs" section?
#
# Usage: review-gate-rule-outputs.sh <page.json>
#   <page.json> is the knowledge base's `read_file` answer for the page, as
#   the workflow saves it: `{ "content": "<html>…" }`, read under a cap.
# Exit 0 when some `<pre class="rule-outputs">` block holds substance, 1 when
# none does (or there is none), 2 on a usage error.
#
# A terminal review's page must carry rule outputs (the template's
# `<pre class="rule-outputs">`): a page without one is a summary, not a
# review. Only substance is checked here — WHICH rules and their shapes live
# in the knowledge base's rule nodes, so rules can be added, edited or
# removed without touching this script.
#
# The question is asked of a block's CONTENT where it OPENS: up to 2,000
# characters after its tag, stopping at a closing tag that comes first,
# markup stripped, and any non-space character passes. An empty block beside
# a substantive one is fine; a block of nothing but markup or spaces is empty.
#
# The closing tag is deliberately NOT required. The workflow's read of the
# page is capped, and a review that sweeps every stated contract in every
# touched file writes a block of hundreds of thousands of characters (PR
# #447: character 7,927 to 973,999 of a 1.26 MB page). A pattern that
# captured up to the closing tag found it beyond the cap, captured nothing,
# and errored a go-ahead as "no Rule outputs section". Whether a block has
# substance is decided where it opens, which the cap always holds.
#
# Markup is stripped twice: every complete tag, and then a tag the 2,000-
# character window cut open (`<a href="…` with no `>` in the window), so a
# block of nothing but a long tag never passes as substance.
#
# ALL whitespace is collapsed to single spaces BEFORE the match, so the
# pattern never needs a newline-crossing mode and carries only the `i` flag:
# jq's regex flags are Oniguruma, not PCRE — `s` is single-line ANCHORS and
# `m` is the dotall — and a PCRE-shaped flag here once silently matched
# nothing across lines. `scripts/__tests__/review-gate-rule-outputs.test.mjs`
# runs this script, with jq, over the shapes that matter.
set -u
if [ $# -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: $0 <page.json>" >&2
  exit 2
fi
ro_pattern="<pre [^>]*class=[\"']rule-outputs[\"'][^>]*>((?:(?!</pre>).){1,2000})"
jq -e --arg pat "$ro_pattern" \
  '(.content? // "") | tostring | gsub("[[:space:]]+"; " ") | [scan($pat; "i")] | flatten | map(tostring | gsub("<[^>]*>"; "") | gsub("<[^>]*$"; "")) | any(test("[^ ]"))' \
  "$1" >/dev/null 2>&1
