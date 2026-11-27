import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBlobHash, gitBlobSha, objectFormatOf } from '../git-blob-sha.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** What `git hash-object --stdin` answers for `bytes`, in a repository of `format`. */
async function gitHashObject(bytes: Buffer, format: 'sha1' | 'sha256'): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'bevel-blob-sha-'));
  try {
    await run('git', ['init', '-q', `--object-format=${format}`, repo]);
    return (await run('git', ['-C', repo, 'hash-object', '--stdin'], bytes)).trim();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

function run(cmd: string, args: string[], input?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin?.end(input);
  });
}

/** Every shipped source file under `src/`, tests aside. */
async function shippedSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') out.push(...(await shippedSources(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('gitBlobSha', () => {
  const BYTES = Buffer.from('---\nread:\n  - deny everyone\n---\n# a page, é\n');

  it('answers what git hash-object answers, in a SHA-1 and in a SHA-256 repository', async () => {
    expect(gitBlobSha(BYTES)).toBe(await gitHashObject(BYTES, 'sha1'));
    expect(gitBlobSha(BYTES, 'sha256')).toBe(await gitHashObject(BYTES, 'sha256'));
    expect(gitBlobSha(Buffer.alloc(0))).toBe(await gitHashObject(Buffer.alloc(0), 'sha1'));
  });

  it('answers the same for bytes fed in parts to gitBlobHash', () => {
    for (const format of ['sha1', 'sha256'] as const) {
      const hash = gitBlobHash(BYTES.length, format);
      for (let at = 0; at < BYTES.length; at += 7) hash.update(BYTES.subarray(at, at + 7));
      expect(hash.digest('hex')).toBe(gitBlobSha(BYTES, format));
    }
  });

  it('tells an id\'s object format by its length', () => {
    expect(objectFormatOf(gitBlobSha(BYTES))).toBe('sha1');
    expect(objectFormatOf(gitBlobSha(BYTES, 'sha256'))).toBe('sha256');
  });

  // One way to compute a blob id: a shipped file that builds git's `blob <size>` header itself is a second one.
  it('is the only shipped code that builds a blob header', async () => {
    const own = join(SRC, 'shared', 'git-blob-sha.ts');
    const builders: string[] = [];
    for (const file of await shippedSources(SRC)) {
      if (file === own) continue;
      if (/blob \$\{|['"]blob ['"]/.test(await readFile(file, 'utf8'))) builders.push(relative(SRC, file).split(sep).join('/'));
    }
    expect(builders).toEqual([]);
    expect(/blob \$\{/.test(await readFile(own, 'utf8'))).toBe(true);
  });
});
