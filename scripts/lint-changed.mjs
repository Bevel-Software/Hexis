#!/usr/bin/env node
/**
 * Lint ratchet: lint only the JS/TS files a change adds or modifies.
 *
 * `eslint .` does not pass on dev yet (errors in files no one has touched
 * since the rules landed), so it cannot gate as a whole; what a pull request
 * CAN be held to is that every file it adds or changes lints clean, with no
 * warnings. Files the config ignores are skipped quietly.
 *
 * The paths come from `git diff -z` and go to ESLint's Node API as an array,
 * never through a shell or `xargs`, so a name with spaces or non-ASCII
 * characters stays one path.
 *
 * Usage:
 *   node scripts/lint-changed.mjs                # HEAD^1..HEAD (CI's merge commit vs its base)
 *   node scripts/lint-changed.mjs <base> [head]  # any range, e.g. origin/dev HEAD
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const LINTED = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'];

/** The JS/TS files `head` adds or changes against `base`, as absolute paths. */
export function changedFiles({ cwd, base = 'HEAD^1', head = 'HEAD' }) {
  const out = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '-z', '--name-only', '--diff-filter=d', base, head, '--', ...LINTED],
    { cwd, encoding: 'utf8' },
  );
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  return out
    .split('\0')
    .filter((p) => p.length > 0)
    .map((p) => resolve(root, p));
}

/**
 * Lints the changed files with the ESLint config found from `cwd`. `ok` is
 * false on any error or warning (`--max-warnings 0`); `output` is ESLint's
 * stylish report, empty when clean.
 */
export async function lintChanged({ cwd, base, head }) {
  const files = changedFiles({ cwd, base, head });
  if (files.length === 0) return { files, ok: true, output: '' };
  const eslint = new ESLint({ cwd, warnIgnored: false });
  const results = await eslint.lintFiles(files);
  const problems = results.reduce((n, r) => n + r.errorCount + r.warningCount, 0);
  const formatter = await eslint.loadFormatter('stylish');
  return { files, ok: problems === 0, output: await formatter.format(results) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  const { files, ok, output } = await lintChanged({ cwd: process.cwd(), base, head });
  console.log(files.length === 0 ? 'No changed JS/TS files.' : `Linting ${files.length} changed file(s):\n${files.join('\n')}`);
  if (output) console.log(output);
  process.exitCode = ok ? 0 : 1;
}
