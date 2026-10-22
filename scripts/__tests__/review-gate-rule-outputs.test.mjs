/**
 * The architecture-review workflow's format gate
 * (`scripts/review-gate-rule-outputs.sh`) decides whether a review's page
 * counts as a review at all, so what it accepts is pinned here, through the
 * script itself and the jq it runs — the pages are the shapes the gate has
 * met or must meet, the real one included: a block whose closing tag lies
 * beyond the workflow's read cap.
 *
 * Run with `pnpm test:scripts` (node's own test runner; no dependencies).
 * Needs `jq` on the PATH, as the workflow's runner has it; skipped without.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'review-gate-rule-outputs.sh');
const hasJq = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;

/** Exit status of the gate over a page with this HTML as its content. */
function gate(html) {
  const dir = mkdtempSync(join(tmpdir(), 'review-gate-'));
  try {
    const page = join(dir, 'page.json');
    writeFileSync(page, JSON.stringify({ content: html }));
    return spawnSync('bash', [script, page], { encoding: 'utf8' }).status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const open = '<pre class="rule-outputs">';
/** Each case needs jq, as the workflow's runner has it; without it the case is reported skipped, not passed. */
const needsJq = { skip: hasJq ? false : 'jq is not installed' };

describe('review gate — a one-pager must carry a non-empty Rule outputs block', () => {
  test('passes a block whose closing tag lies beyond the read cap — PR #447: a long review is still a review', needsJq, () => {
    // 300,000 characters of rule outputs, cut at a 200,000-character cap: no closing tag in what was read.
    const block = `Intent: a damaged document never hangs the server.\n${'Stated contracts: "…" at a/b.ts:1 — holds\n'.repeat(6000)}`;
    const page = `<html><body><h2>Rule outputs</h2>${open}${block}</pre></body></html>`.slice(0, 200_000);
    assert.equal(gate(page), 0);
  });

  test('passes a short block that closes, with content opening in markup, and an empty block beside a full one', needsJq, () => {
    assert.equal(gate(`<html><body>${open}<b>Intent:</b> keep the server up</pre></body></html>`), 0);
    assert.equal(gate(`<html><body><pre class='rule-outputs'></pre>${open}Intent: y</pre></body></html>`), 0);
  });

  test('refuses a page with no block, and a block of nothing but spaces', needsJq, () => {
    assert.equal(gate('<html><body><h2>Rule outputs</h2><p>Intent: narrated in prose only.</p></body></html>'), 1);
    assert.equal(gate(`<html><body>${open}   \n\t  </pre><p>prose</p></body></html>`), 1);
  });

  test('refuses a block of nothing but markup — complete tags, and a tag the window cuts open', needsJq, () => {
    assert.equal(gate(`<html><body>${open}<b></b><i> </i></pre></body></html>`), 1);
    // A single tag longer than the 2,000-character window: nothing inside it is content.
    const longTag = `<a href="${'x'.repeat(2_500)}">`;
    assert.equal(gate(`<html><body>${open}${longTag}</a></pre></body></html>`), 1);
  });

  test('is a usage error without a readable page', needsJq, () => {
    assert.equal(spawnSync('bash', [script], { encoding: 'utf8' }).status, 2);
  });
});
