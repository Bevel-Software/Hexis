// node --test scripts/__tests__/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { changedFiles, lintChanged } from '../lint-changed.mjs';

/** A scratch repo with its own ESLint config, a base commit and a head commit made by `change`. */
function scratchRepo(change) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-changed-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, 'eslint.config.mjs'), "export default [{ rules: { 'no-debugger': 'error', 'no-unused-vars': 'warn' } }];\n");
  writeFileSync(join(dir, 'untouched bad.js'), 'debugger;\n');
  writeFileSync(join(dir, 'gone.js'), 'export const gone = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  change(dir, git);
  git('add', '-A');
  git('commit', '-qm', 'head');
  return dir;
}

test('a path with spaces or non-ASCII characters reaches ESLint whole', async (t) => {
  const dir = scratchRepo((d, git) => {
    mkdirSync(join(d, 'sub dir'));
    writeFileSync(join(d, 'sub dir', 'bad file.js'), 'debugger;\n');
    writeFileSync(join(d, 'ünïcødé bad.js'), 'debugger;\n');
    writeFileSync(join(d, 'notes.md'), '# not linted\n');
    git('rm', '-q', 'gone.js');
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const files = changedFiles({ cwd: dir });
  assert.deepEqual(files.map((f) => basename(f)).sort(), ['bad file.js', 'ünïcødé bad.js']);

  const { ok, output } = await lintChanged({ cwd: dir });
  assert.equal(ok, false);
  assert.match(output, /sub dir[\\/]bad file\.js/);
  assert.match(output, /ünïcødé bad\.js/);
  assert.match(output, /no-debugger/);
  // Only the change is held to the rules, not the file it left alone.
  assert.doesNotMatch(output, /untouched bad\.js/);
});

test('a lint error fails the check, and a warning fails it too', async (t) => {
  const withError = scratchRepo((d) => writeFileSync(join(d, 'a.js'), 'debugger;\n'));
  const withWarning = scratchRepo((d) => writeFileSync(join(d, 'b.js'), 'const unused = 1;\n'));
  t.after(() => {
    rmSync(withError, { recursive: true, force: true });
    rmSync(withWarning, { recursive: true, force: true });
  });

  assert.equal((await lintChanged({ cwd: withError })).ok, false);
  assert.equal((await lintChanged({ cwd: withWarning })).ok, false);
});

test('clean changes, and a change with no JS/TS files, pass', async (t) => {
  const clean = scratchRepo((d) => writeFileSync(join(d, 'c.js'), 'export const c = 1;\n'));
  const none = scratchRepo((d) => writeFileSync(join(d, 'readme.md'), '# hi\n'));
  t.after(() => {
    rmSync(clean, { recursive: true, force: true });
    rmSync(none, { recursive: true, force: true });
  });

  assert.equal((await lintChanged({ cwd: clean })).ok, true);
  assert.deepEqual(await lintChanged({ cwd: none }), { files: [], ok: true, output: '' });
});
