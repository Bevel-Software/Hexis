/**
 * The lint ratchet (`scripts/lint-ratchet.mjs`) decides whether a pull
 * request may merge, so what it counts is pinned here: against a throwaway
 * git repository with a one-rule ESLint config, a base branch, and a change
 * on top of it.
 *
 * Run with `pnpm test:scripts` (node's own test runner; no dependencies).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { lintRatchet } from '../lint-ratchet.mjs';

/** One rule, so a problem is exactly an unused variable. `ignored/` is ignored; `.ts` has no config. */
const CONFIG = `export default [
  { ignores: ['ignored/**'] },
  { files: ['**/*.js'], rules: { 'no-unused-vars': 'error' } },
];
`;
const CLEAN = 'export const used = 1;\n';
const ONE_PROBLEM = 'const unusedOne = 1;\nexport const used = 1;\n';
const TWO_PROBLEMS = 'const unusedOne = 1;\nconst unusedTwo = 2;\nexport const used = 1;\n';

let root;

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
function write(file, content) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}
function commit(message) {
  git('add', '-A');
  git('commit', '-q', '-m', message);
}
/** The ratchet's rows by file, as `{ before, now }`, and whether it fails. */
async function run() {
  const { rows, worse } = await lintRatchet({ root, baseRef: 'base' });
  return {
    counts: Object.fromEntries(rows.map((r) => [r.file, { before: r.before, now: r.now }])),
    fails: worse.length > 0,
  };
}

describe('lint ratchet', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lint-ratchet-'));
    git('init', '-q', '-b', 'base');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    write('eslint.config.js', CONFIG);
    write('has-one.js', ONE_PROBLEM);
    write('clean.js', CLEAN);
    commit('base');
    git('checkout', '-q', '-b', 'change');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('fails when a changed file gains a problem, and says which', async () => {
    write('clean.js', ONE_PROBLEM);
    write('has-one.js', TWO_PROBLEMS);
    commit('worse');
    const { counts, fails } = await run();
    assert.equal(fails, true);
    assert.deepEqual(counts['clean.js'], { before: 0, now: 1 });
    assert.deepEqual(counts['has-one.js'], { before: 1, now: 2 });
  });

  test('passes when a changed file keeps the problems it already had', async () => {
    write('has-one.js', `// touched\n${ONE_PROBLEM}`);
    commit('same');
    const { counts, fails } = await run();
    assert.equal(fails, false);
    assert.deepEqual(counts['has-one.js'], { before: 1, now: 1 });
  });

  test('passes when a changed file loses problems', async () => {
    write('has-one.js', CLEAN);
    commit('better');
    const { counts, fails } = await run();
    assert.equal(fails, false);
    assert.deepEqual(counts['has-one.js'], { before: 1, now: 0 });
  });

  test('counts a new file from zero: one with a problem fails, a clean one passes', async () => {
    write('new-clean.js', CLEAN);
    commit('clean add');
    let result = await run();
    assert.equal(result.fails, false);
    assert.deepEqual(result.counts['new-clean.js'], { before: 0, now: 0 });

    write('new-dirty.js', ONE_PROBLEM);
    commit('dirty add');
    result = await run();
    assert.equal(result.fails, true);
    assert.deepEqual(result.counts['new-dirty.js'], { before: 0, now: 1 });
  });

  // git C-quotes such a path in its usual output ("caf\303\251.js"); read
  // that way the file would never look linted, and a problem it gained would
  // pass. The old path of a rename is read back by that name too.
  test('counts a file whose name git would quote, added or moved', async () => {
    // Its own content, so git pairs no other file with it as a rename.
    const cafeProblem = 'const unusedCafé = 1;\nexport const café = 1;\n';
    write('café.js', cafeProblem);
    commit('add, quoted name');
    let result = await run();
    assert.equal(result.fails, true);
    assert.deepEqual(result.counts['café.js'], { before: 0, now: 1 });

    git('checkout', '-q', 'base');
    write('café.js', cafeProblem);
    commit('base has it');
    git('checkout', '-q', 'change');
    git('merge', '-q', 'base');
    mkdirSync(join(root, 'déplacé'));
    git('mv', 'café.js', 'déplacé/café.js');
    git('mv', 'has-one.js', 'déplacé/has-one.js');
    commit('move, quoted names');
    result = await run();
    assert.equal(result.fails, false);
    assert.deepEqual(result.counts['café.js -> déplacé/café.js'], { before: 1, now: 1 });
    assert.deepEqual(result.counts['has-one.js -> déplacé/has-one.js'], { before: 1, now: 1 });
  });

  test('compares a renamed file with its content under the old path', async () => {
    mkdirSync(join(root, 'moved'));
    git('mv', 'has-one.js', 'moved/has-one.js');
    commit('move');
    const { counts, fails } = await run();
    assert.equal(fails, false);
    assert.deepEqual(counts['has-one.js -> moved/has-one.js'], { before: 1, now: 1 });
    assert.equal(counts['moved/has-one.js'], undefined);
  });

  test('still fails a renamed file that gains a problem', async () => {
    mkdirSync(join(root, 'moved'));
    git('mv', 'has-one.js', 'moved/has-one.js');
    write('moved/has-one.js', TWO_PROBLEMS);
    commit('move and worsen');
    const { counts, fails } = await run();
    assert.equal(fails, true);
    assert.deepEqual(counts['has-one.js -> moved/has-one.js'], { before: 1, now: 2 });
  });

  // Below git's rename threshold (`-M`, half the content) a move is an
  // addition, counted from zero: a rewrite that large owns the problems it
  // carried over, where a move alone or with smaller edits does not.
  test('counts a file moved and rewritten past half its content from zero, so a carried-over problem fails', async () => {
    mkdirSync(join(root, 'moved'));
    git('mv', 'has-one.js', 'moved/rewritten.js');
    const rewritten = [
      'const unusedOne = 1;',
      ...Array.from({ length: 8 }, (_, i) => `export const added${i} = ${i};`),
      '',
    ].join('\n');
    write('moved/rewritten.js', rewritten);
    commit('move and rewrite');
    const { counts, fails } = await run();
    assert.equal(fails, true);
    assert.deepEqual(counts['moved/rewritten.js'], { before: 0, now: 1 });
    assert.equal(counts['has-one.js -> moved/rewritten.js'], undefined);
  });

  test('skips files ESLint ignores and files no config covers', async () => {
    write('ignored/dirty.js', ONE_PROBLEM);
    write('uncovered.ts', ONE_PROBLEM);
    commit('outside the config');
    const { counts, fails } = await run();
    assert.equal(fails, false);
    assert.deepEqual(Object.keys(counts), []);
  });

  test('counts nothing for a deleted file or a file it does not lint', async () => {
    git('rm', '-q', 'has-one.js');
    write('notes.md', 'const unused = 1;\n');
    commit('delete and add prose');
    const { counts, fails } = await run();
    assert.equal(fails, false);
    assert.deepEqual(Object.keys(counts), []);
  });

  test('counts only changes since the merge base, not later commits on the base', async () => {
    git('checkout', '-q', 'base');
    write('clean.js', ONE_PROBLEM);
    commit('base gets worse later');
    git('checkout', '-q', 'change');
    write('other.js', CLEAN);
    commit('unrelated');
    const { counts, fails } = await run();
    assert.equal(fails, false);
    assert.deepEqual(Object.keys(counts), ['other.js']);
  });
});
