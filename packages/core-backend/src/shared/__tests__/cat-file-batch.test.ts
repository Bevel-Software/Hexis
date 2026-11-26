import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { catFileBatchBytes } from '../cat-file-batch.js';
import type { IGitRunner } from '../git.contract.js';

const execFileAsync = promisify(execFile);
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The real git binary behind the runner seam, nothing else. */
const runner = {
  run: async (cwd: string, args: string[], opts: { input?: string }) => {
    const child = execFileAsync('git', args, { cwd, encoding: 'buffer', maxBuffer: 1 << 26 });
    child.child.stdin?.end(opts.input ?? '');
    const { stdout } = await child;
    return { stdout, stderr: Buffer.alloc(0) };
  },
} as unknown as IGitRunner;

describe('catFileBatchBytes', () => {
  let repo: string;
  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'cat-file-batch-'));
    const git = (...args: string[]) =>
      execFileAsync('git', args, {
        cwd: repo,
        env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' },
      });
    await git('init', '-b', 'main');
    await fs.mkdir(path.join(repo, 'dir'));
    await fs.writeFile(path.join(repo, 'dir', 'a b.md'), 'héllo\n');
    await git('add', '.');
    await git('commit', '-m', 'one');
  });
  afterAll(() => fs.rm(repo, { recursive: true, force: true }));

  it('answers each spec in order: a blob with its bytes and object id, a missing spec, a tree', async () => {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD:dir/a b.md'], { cwd: repo });
    const [blob, missing, tree] = await catFileBatchBytes(runner, repo, ['HEAD:dir/a b.md', 'HEAD:nope.md', 'HEAD:dir']);
    expect(blob).toMatchObject({ kind: 'blob', oid: stdout.trim() });
    expect(blob?.kind === 'blob' && blob.bytes.toString('utf-8')).toBe('héllo\n');
    expect(missing).toEqual({ kind: 'missing' });
    expect(tree).toEqual({ kind: 'non-blob', type: 'tree' });
  });
});

// One reader of the `cat-file --batch` protocol: a second parser of it is
// where a misaligned answer (one spec's bytes handed to the next) comes back.
it('no shipped file but the shared reader speaks `cat-file --batch`', async () => {
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') await walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        if (/'cat-file',\s*'--batch'/.test(await fs.readFile(full, 'utf-8'))) offenders.push(path.relative(SRC, full));
      }
    }
  };
  await walk(SRC);
  expect(offenders).toEqual([path.join('shared', 'cat-file-batch.ts')]);
});
