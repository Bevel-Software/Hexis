#!/usr/bin/env node
/**
 * Lint ratchet.
 *
 * `eslint .` does not pass on the whole repo today: it reports problems that
 * predate any one change, so a CI step running it would fail on every pull
 * request and prove nothing about the one in front of it. This enforces the
 * rule that does hold: no file a change touches may come out of it with more
 * ESLint problems (errors plus warnings) than it went in with.
 *
 * Each changed file is linted as it is now, and as it was at the merge base
 * with `--base` (its old content, under today's config). A renamed or moved
 * file is compared with its content under the old path, so a move alone
 * never fails. A file the change adds counts from zero, so a new file must
 * lint clean. Files ESLint ignores, or that no config covers, are skipped;
 * deleted files have nothing to count.
 *
 * Usage:
 *   node scripts/lint-ratchet.mjs                    # against origin/dev
 *   node scripts/lint-ratchet.mjs --base origin/main
 */

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LINTED = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const at = process.argv.indexOf('--base');
const baseRef = at > 0 ? process.argv[at + 1] : 'origin/dev';
if (!baseRef) {
  console.error('--base needs a ref');
  process.exit(2);
}
const base = git('merge-base', baseRef, 'HEAD').trim();

/**
 * Changed files that still exist, each with the path its content had at the
 * base (`null` for an added file). A rename's line is `R<score>\told\tnew`.
 */
const changed = git('diff', '--name-status', '-M', '--diff-filter=AMR', `${base}...HEAD`)
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [status, first, second] = line.split('\t');
    if (status.startsWith('R')) return { file: second, was: first };
    return { file: first, was: status === 'A' ? null : first };
  })
  .filter(({ file }) => LINTED.test(file));

const eslint = new ESLint({ cwd: ROOT });
const problems = (results) => results.reduce((n, r) => n + r.errorCount + r.warningCount, 0);

const rows = [];
for (const { file, was } of changed) {
  const abs = join(ROOT, file);
  if (await eslint.isPathIgnored(abs)) continue;
  if (!(await eslint.calculateConfigForFile(abs))) continue;
  const nowResults = await eslint.lintFiles([abs]);
  const now = problems(nowResults);
  // The old content is linted under the NEW path, so the same config judges
  // both sides of a move.
  const before = was === null
    ? 0
    : problems(await eslint.lintText(git('show', `${base}:${was}`), { filePath: abs }));
  rows.push({ file: was && was !== file ? `${was} -> ${file}` : file, before, now, results: nowResults });
}

const worse = rows.filter((r) => r.now > r.before);
console.log(`Linted ${rows.length} changed file(s) against ${baseRef} (merge base ${base.slice(0, 8)}).`);
for (const r of rows) {
  const mark = r.now > r.before ? 'UP  ' : r.now < r.before ? 'down' : 'same';
  console.log(`  ${mark}  ${r.before} -> ${r.now}  ${r.file}`);
}

if (worse.length > 0) {
  const formatter = await eslint.loadFormatter('stylish');
  console.log(await formatter.format(worse.flatMap((r) => r.results)));
  console.error(
    `\n${worse.length} file(s) gained ESLint problems. Fix the new ones; ` +
      'problems a file already had before this change do not fail the check.',
  );
  process.exit(1);
}
console.log('\nNo changed file gained an ESLint problem.');
